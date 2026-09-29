import { DatabaseSync } from 'node:sqlite';
import { existsSync, chmodSync } from 'node:fs';
import {
  ALLOWED_STAGES,
  type SettlementJournal,
  type SettlementJob,
  type SettlementJobIdentity,
  type SettlementJobScope,
  type SettlementJobStage,
} from './types.js';

export const CURRENT_SCHEMA_VERSION = 2;

export interface SqliteJournalOptions {
  busyTimeoutMs?: number;
  walMode?: boolean;
}

interface RawJobRow {
  schema_version: number;
  chain_id: number;
  rental_manager_address: string;
  rental_id: string;
  node_id: string;
  stage: string;
  tx_hash: string | null;
  sender_address: string | null;
  transaction_nonce: string | null;
  attempts: number;
  next_retry_at_ms: number | null;
  failure_code: string | null;
  claim_owner: string | null;
  claim_expires_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export class SqliteSettlementJournal implements SettlementJournal {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;
  private readonly busyTimeoutMs: number;
  private readonly walMode: boolean;

  constructor(dbPath: string, options: SqliteJournalOptions = {}) {
    this.dbPath = dbPath;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    this.walMode = options.walMode ?? true;
    this.initialize();
  }

  isClosed(): boolean {
    return this.db === null;
  }

  initialize(): void {
    if (this.db) {
      return;
    }

    try {
      const db = new DatabaseSync(this.dbPath);
      this.db = db;

      // Fast-fail and busy timeout configuration
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      if (this.dbPath !== ':memory:' && this.walMode) {
        db.exec('PRAGMA journal_mode = WAL;');
      }
      db.exec('PRAGMA foreign_keys = ON;');

      // Restrictive file permissions for database file if on filesystem
      if (this.dbPath !== ':memory:' && existsSync(this.dbPath)) {
        try {
          chmodSync(this.dbPath, 0o600);
        } catch {
          // Ignore on platforms/filesystems that do not support POSIX chmod
        }
      }

      // Integrity check — fail closed without deletion if corrupted
      const integrityRow = db.prepare('PRAGMA integrity_check;').get() as { integrity_check?: string } | undefined;
      if (!integrityRow || integrityRow.integrity_check !== 'ok') {
        throw new Error(`Corrupt SQLite database: integrity check returned ${integrityRow?.integrity_check ?? 'unknown'}`);
      }

      // Schema version check and migration
      const versionRow = db.prepare('PRAGMA user_version;').get() as { user_version?: number } | undefined;
      const currentVersion = versionRow?.user_version ?? 0;

      if (currentVersion === 0) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS settlement_jobs (
            schema_version INTEGER NOT NULL,
            chain_id INTEGER NOT NULL,
            rental_manager_address TEXT NOT NULL,
            rental_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            stage TEXT NOT NULL CHECK (
              stage IN (
                'PREPARING',
                'SUBMITTED',
                'MINED',
                'RECONCILING',
                'CONFIRMED',
                'FAILED'
              )
            ),
            tx_hash TEXT NULL,
            sender_address TEXT NULL,
            transaction_nonce TEXT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at_ms INTEGER NULL,
            failure_code TEXT NULL,
            claim_owner TEXT NULL,
            claim_expires_at_ms INTEGER NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (chain_id, rental_manager_address, rental_id)
          );

          CREATE INDEX IF NOT EXISTS idx_settlement_jobs_scope 
          ON settlement_jobs(chain_id, rental_manager_address, node_id, stage);
        `);
        db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
      } else if (currentVersion === 1) {
        // v1 -> v2 migration
        // 1. Pre-validate existing rows to ensure they conform to allowable values
        const rows = db.prepare('SELECT * FROM settlement_jobs;').all() as unknown as RawJobRow[];
        for (const row of rows) {
          this.validateRow(row);
        }

        // 2. Perform migration transactionally
        db.exec('BEGIN IMMEDIATE TRANSACTION;');
        try {
          db.exec(`
            CREATE TABLE settlement_jobs_v2 (
              schema_version INTEGER NOT NULL,
              chain_id INTEGER NOT NULL,
              rental_manager_address TEXT NOT NULL,
              rental_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              stage TEXT NOT NULL CHECK (
                stage IN (
                  'PREPARING',
                  'SUBMITTED',
                  'MINED',
                  'RECONCILING',
                  'CONFIRMED',
                  'FAILED'
                )
              ),
              tx_hash TEXT NULL,
              sender_address TEXT NULL,
              transaction_nonce TEXT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              next_retry_at_ms INTEGER NULL,
              failure_code TEXT NULL,
              claim_owner TEXT NULL,
              claim_expires_at_ms INTEGER NULL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (chain_id, rental_manager_address, rental_id)
            );

            INSERT INTO settlement_jobs_v2 (
              schema_version, chain_id, rental_manager_address, rental_id, node_id,
              stage, tx_hash, sender_address, transaction_nonce, attempts,
              next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
              created_at_ms, updated_at_ms
            )
            SELECT
              2, chain_id, rental_manager_address, rental_id, node_id,
              stage, tx_hash, sender_address, transaction_nonce, attempts,
              next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
              created_at_ms, updated_at_ms
            FROM settlement_jobs;

            DROP TABLE settlement_jobs;
            ALTER TABLE settlement_jobs_v2 RENAME TO settlement_jobs;
            CREATE INDEX IF NOT EXISTS idx_settlement_jobs_scope 
            ON settlement_jobs(chain_id, rental_manager_address, node_id, stage);
            PRAGMA user_version = 2;
          `);
          db.exec('COMMIT;');
        } catch (err) {
          db.exec('ROLLBACK;');
          throw err;
        }
      } else if (currentVersion === CURRENT_SCHEMA_VERSION) {
        // Current supported version
      } else if (currentVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(`Unsupported settlement journal schema version ${currentVersion}`);
      }
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('DATABASE_CLOSED: Settlement journal is closed or not initialized');
    }
    return this.db;
  }

  private validateRow(row: RawJobRow): SettlementJob {
    if (!Number.isSafeInteger(row.schema_version) || row.schema_version < 1 || row.schema_version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`MALFORMED_ROW: Invalid schema_version ${row.schema_version}`);
    }
    if (!Number.isSafeInteger(row.chain_id) || row.chain_id !== 46630) {
      throw new Error(`MALFORMED_ROW: Invalid chain_id ${row.chain_id}`);
    }
    if (typeof row.rental_manager_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(row.rental_manager_address)) {
      throw new Error(`MALFORMED_ROW: Invalid rental_manager_address ${row.rental_manager_address}`);
    }
    if (typeof row.rental_id !== 'string' || !/^[1-9][0-9]*$/.test(row.rental_id)) {
      throw new Error(`MALFORMED_ROW: Invalid rental_id ${row.rental_id}`);
    }
    if (typeof row.node_id !== 'string' || row.node_id !== '1') {
      throw new Error(`MALFORMED_ROW: Invalid node_id ${row.node_id}`);
    }
    if (!ALLOWED_STAGES.has(row.stage as SettlementJobStage)) {
      throw new Error(`MALFORMED_ROW: Invalid stage ${row.stage}`);
    }
    const stage = row.stage as SettlementJobStage;

    if (row.tx_hash !== null) {
      if (typeof row.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.tx_hash)) {
        throw new Error(`MALFORMED_ROW: Invalid tx_hash ${row.tx_hash}`);
      }
    }

    if ((stage === 'SUBMITTED' || stage === 'MINED') && !row.tx_hash) {
      throw new Error(`MALFORMED_ROW: Stage ${stage} requires non-null tx_hash`);
    }

    if (row.sender_address !== null) {
      if (typeof row.sender_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(row.sender_address)) {
        throw new Error(`MALFORMED_ROW: Invalid sender_address ${row.sender_address}`);
      }
    }

    if (row.transaction_nonce !== null) {
      if (typeof row.transaction_nonce !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.transaction_nonce)) {
        throw new Error(`MALFORMED_ROW: Invalid transaction_nonce ${row.transaction_nonce}`);
      }
    }

    if (!Number.isSafeInteger(row.attempts) || row.attempts < 0) {
      throw new Error(`MALFORMED_ROW: Invalid attempts ${row.attempts}`);
    }

    if (row.next_retry_at_ms !== null && (!Number.isSafeInteger(row.next_retry_at_ms) || row.next_retry_at_ms < 0)) {
      throw new Error(`MALFORMED_ROW: Invalid next_retry_at_ms ${row.next_retry_at_ms}`);
    }

    if (row.claim_expires_at_ms !== null && (!Number.isSafeInteger(row.claim_expires_at_ms) || row.claim_expires_at_ms < 0)) {
      throw new Error(`MALFORMED_ROW: Invalid claim_expires_at_ms ${row.claim_expires_at_ms}`);
    }

    if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) {
      throw new Error(`MALFORMED_ROW: Invalid created_at_ms ${row.created_at_ms}`);
    }

    if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) {
      throw new Error(`MALFORMED_ROW: Invalid updated_at_ms ${row.updated_at_ms}`);
    }

    return {
      schemaVersion: row.schema_version,
      chainId: row.chain_id,
      rentalManagerAddress: row.rental_manager_address,
      rentalId: row.rental_id,
      nodeId: row.node_id,
      stage,
      txHash: row.tx_hash,
      senderAddress: row.sender_address,
      transactionNonce: row.transaction_nonce,
      attempts: row.attempts,
      nextRetryAtMs: row.next_retry_at_ms,
      failureCode: row.failure_code,
      claimOwner: row.claim_owner,
      claimExpiresAtMs: row.claim_expires_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  private mapRow(row: RawJobRow): SettlementJob {
    return this.validateRow(row);
  }

  private validateIdentity(identity: SettlementJobIdentity, nodeId?: string): void {
    if (!Number.isSafeInteger(identity.chainId) || identity.chainId !== 46630) {
      throw new Error(`MALFORMED_IDENTITY: Invalid chain_id ${identity.chainId}`);
    }
    if (typeof identity.rentalManagerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(identity.rentalManagerAddress)) {
      throw new Error(`MALFORMED_IDENTITY: Invalid rental_manager_address ${identity.rentalManagerAddress}`);
    }
    if (typeof identity.rentalId !== 'string' || !/^[1-9][0-9]*$/.test(identity.rentalId)) {
      throw new Error(`MALFORMED_IDENTITY: Invalid rental_id ${identity.rentalId}`);
    }
    if (nodeId !== undefined && nodeId !== '1') {
      throw new Error(`MALFORMED_IDENTITY: Invalid node_id ${nodeId}`);
    }
  }

  createOrLoadJob(
    identity: SettlementJobIdentity,
    initial: { nodeId: string; ownerId?: string; claimExpiresAtMs?: number },
  ): SettlementJob {
    this.validateIdentity(identity, initial.nodeId);
    const db = this.ensureDb();
    const managerAddr = identity.rentalManagerAddress.toLowerCase();
    const rentalIdStr = String(identity.rentalId);
    const nodeIdStr = String(initial.nodeId);

    const existing = this.getJob(identity);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    try {
      db.prepare(`
        INSERT INTO settlement_jobs (
          schema_version, chain_id, rental_manager_address, rental_id, node_id,
          stage, tx_hash, sender_address, transaction_nonce, attempts,
          next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, ?, ?, ?,
          'PREPARING', NULL, NULL, NULL, 0,
          NULL, NULL, ?, ?,
          ?, ?
        )
      `).run(
        CURRENT_SCHEMA_VERSION,
        identity.chainId,
        managerAddr,
        rentalIdStr,
        nodeIdStr,
        initial.ownerId ?? null,
        initial.claimExpiresAtMs ?? null,
        now,
        now,
      );
    } catch {
      // Race condition with another worker: return the winning row
      const loaded = this.getJob(identity);
      if (loaded) return loaded;
      throw new Error(`Failed to create or load settlement job for rental ${rentalIdStr}`);
    }

    const job = this.getJob(identity);
    if (!job) {
      throw new Error(`Created settlement job was not readable for rental ${rentalIdStr}`);
    }
    return job;
  }

  getJob(identity: SettlementJobIdentity): SettlementJob | null {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT * FROM settlement_jobs
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
    `).get(
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
    ) as RawJobRow | undefined;

    return row ? this.mapRow(row) : null;
  }

  listRecoverableJobs(scope: SettlementJobScope): SettlementJob[] {
    if (!Number.isSafeInteger(scope.chainId) || scope.chainId !== 46630) {
      throw new Error(`MALFORMED_SCOPE: Invalid chain_id ${scope.chainId}`);
    }
    if (typeof scope.rentalManagerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(scope.rentalManagerAddress)) {
      throw new Error(`MALFORMED_SCOPE: Invalid rental_manager_address ${scope.rentalManagerAddress}`);
    }
    if (scope.nodeId !== undefined && scope.nodeId !== '1') {
      throw new Error(`MALFORMED_SCOPE: Invalid node_id ${scope.nodeId}`);
    }
    const db = this.ensureDb();
    const managerAddr = scope.rentalManagerAddress.toLowerCase();

    let rows: RawJobRow[];
    if (scope.nodeId !== undefined) {
      rows = db.prepare(`
        SELECT * FROM settlement_jobs
        WHERE chain_id = ? AND rental_manager_address = ? AND node_id = ? AND stage != 'CONFIRMED'
        ORDER BY created_at_ms ASC
      `).all(scope.chainId, managerAddr, String(scope.nodeId)) as unknown as RawJobRow[];
    } else {
      rows = db.prepare(`
        SELECT * FROM settlement_jobs
        WHERE chain_id = ? AND rental_manager_address = ? AND stage != 'CONFIRMED'
        ORDER BY created_at_ms ASC
      `).all(scope.chainId, managerAddr) as unknown as RawJobRow[];
    }

    return rows.map((r) => this.mapRow(r));
  }

  claimJob(
    identity: SettlementJobIdentity,
    ownerId: string,
    leaseExpiresAtMs: number,
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET claim_owner = ?, claim_expires_at_ms = ?, updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND (claim_owner IS NULL OR claim_expires_at_ms IS NULL OR claim_expires_at_ms < ? OR claim_owner = ?)
        AND stage != 'CONFIRMED'
    `).run(
      ownerId,
      leaseExpiresAtMs,
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      now,
      ownerId,
    );

    return Number(res.changes) === 1;
  }

  renewClaim(
    identity: SettlementJobIdentity,
    ownerId: string,
    leaseExpiresAtMs: number,
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET claim_expires_at_ms = ?, updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
    `).run(
      leaseExpiresAtMs,
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      ownerId,
    );

    return Number(res.changes) === 1;
  }

  releaseClaim(
    identity: SettlementJobIdentity,
    ownerId: string,
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET claim_owner = NULL, claim_expires_at_ms = NULL, updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
    `).run(
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordPreparing(
    identity: SettlementJobIdentity,
    params: { senderAddress: string; transactionNonce: string; ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET stage = 'PREPARING',
          sender_address = ?,
          transaction_nonce = ?,
          attempts = attempts + 1,
          failure_code = NULL,
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
        AND stage = 'PREPARING'
    `).run(
      params.senderAddress.toLowerCase(),
      String(params.transactionNonce),
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordSubmitted(
    identity: SettlementJobIdentity,
    params: { txHash: string; ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET stage = 'SUBMITTED',
          tx_hash = ?,
          failure_code = NULL,
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
        AND stage = 'PREPARING'
    `).run(
      params.txHash,
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordMined(
    identity: SettlementJobIdentity,
    params: { ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET stage = 'MINED',
          failure_code = NULL,
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
        AND stage IN ('SUBMITTED', 'MINED')
    `).run(
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordReconciling(
    identity: SettlementJobIdentity,
    params: { ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET stage = 'RECONCILING',
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
        AND stage IN ('MINED', 'RECONCILING')
    `).run(
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordConfirmed(
    identity: SettlementJobIdentity,
    params: { ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET stage = 'CONFIRMED',
          claim_owner = NULL,
          claim_expires_at_ms = NULL,
          failure_code = NULL,
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND (claim_owner = ? OR claim_owner IS NULL)
        AND stage IN ('RECONCILING', 'MINED', 'PREPARING', 'SUBMITTED')
    `).run(
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordFailed(
    identity: SettlementJobIdentity,
    params: { failureCode: string; ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET stage = 'FAILED',
          failure_code = ?,
          claim_owner = NULL,
          claim_expires_at_ms = NULL,
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
        AND stage != 'CONFIRMED'
    `).run(
      params.failureCode,
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  recordRetryableFailure(
    identity: SettlementJobIdentity,
    params: { failureCode: string; nextRetryAtMs: number; ownerId: string },
  ): boolean {
    this.validateIdentity(identity);
    const db = this.ensureDb();
    const now = Date.now();
    const res = db.prepare(`
      UPDATE settlement_jobs
      SET next_retry_at_ms = ?,
          failure_code = ?,
          updated_at_ms = ?
      WHERE chain_id = ? AND rental_manager_address = ? AND rental_id = ?
        AND claim_owner = ?
        AND stage NOT IN ('CONFIRMED', 'FAILED')
    `).run(
      params.nextRetryAtMs,
      params.failureCode,
      now,
      identity.chainId,
      identity.rentalManagerAddress.toLowerCase(),
      String(identity.rentalId),
      params.ownerId,
    );

    return Number(res.changes) === 1;
  }

  pruneConfirmed(beforeTimestampMs: number): number {
    const db = this.ensureDb();
    const res = db.prepare(`
      DELETE FROM settlement_jobs
      WHERE stage = 'CONFIRMED' AND updated_at_ms < ?
    `).run(beforeTimestampMs);

    return Number(res.changes);
  }
}
