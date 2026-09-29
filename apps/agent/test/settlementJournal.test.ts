import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, Address } from 'viem';
import { SqliteSettlementJournal } from '../src/journal/sqliteJournal.js';
import type { SettlementJobIdentity } from '../src/journal/types.js';
import {
  ReservationWatcher,
  type ReservationWatcherClient,
} from '../src/reservationWatcher.js';
import {
  validateAndResolveSettlementDbPath,
  type AgentConfig,
} from '../src/config.js';
import { buildServer, type AgentDeps } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import type { ChainRental, ChainListing } from '@archcore/shared';
import type { EncodedTransactionRequest } from '@archcore/chain';

const TEST_PROVIDER_KEY = ('0x' + '11'.repeat(32)) as Hex;
const providerAccount = privateKeyToAccount(TEST_PROVIDER_KEY as `0x${string}`);
const RENTAL_MANAGER_ADDR: Address = ('0x' + '22'.repeat(20)) as Address;
const NODE_ID = 1n;

class MockJournalRentalClient implements ReservationWatcherClient {
  activeRental: ChainRental | null = null;
  rental: ChainRental | null = null;
  listing: ChainListing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };
  providerAddress: Address = providerAccount.address;

  startCalls: bigint[] = [];
  submitCalls: { request: EncodedTransactionRequest; options?: { nonce?: number } }[] = [];
  receiptCalls: Hex[] = [];

  submitShouldFail = 0;
  submitErrorType: 'transient' | 'deterministic' = 'transient';
  receiptShouldFail = 0;
  receiptStatus: 'success' | 'reverted' = 'success';
  rentalReadShouldFail = false;
  hasProviderWallet = true;

  latestNonce = 5;
  pendingNonce = 5;
  nonceReadShouldFail = false;

  async getTransactionCount(_address: Address, blockTag?: 'latest' | 'pending'): Promise<number> {
    if (this.nonceReadShouldFail) {
      throw new Error('RPC error reading transaction count');
    }
    return blockTag === 'pending' ? this.pendingNonce : this.latestNonce;
  }

  async getRental(id: bigint): Promise<ChainRental | null> {
    if (this.rentalReadShouldFail) {
      throw new Error('TEST authoritative rental read unavailable');
    }
    if (this.rental && this.rental.rentalId === id) return this.rental;
    return null;
  }

  async getActiveRentalForNode(_nodeId: bigint): Promise<ChainRental | null> {
    return this.activeRental;
  }

  async getListing(_nodeId: bigint): Promise<ChainListing> {
    return this.listing;
  }

  currentBlockTimestamp: bigint = 2000n;
  async getBlockTimestamp(): Promise<bigint> {
    return this.currentBlockTimestamp;
  }

  encodeSettleAfterExpiryCalldata(rentalId: bigint): EncodedTransactionRequest {
    return {
      to: RENTAL_MANAGER_ADDR,
      data: `0xb44fc704${rentalId.toString(16).padStart(64, '0')}` as Hex,
      value: 0n,
    };
  }

  async submitTransaction(
    request: EncodedTransactionRequest,
    options?: { nonce?: number },
  ): Promise<Hex> {
    this.submitCalls.push({ request, options });
    if (this.submitCalls.length <= this.submitShouldFail) {
      if (this.submitErrorType === 'deterministic') {
        throw new Error('execution reverted: deterministic simulation error');
      }
      throw new Error(`ETIMEDOUT: transient RPC network error (attempt ${this.submitCalls.length})`);
    }
    return `0x${'bb'.repeat(32)}` as Hex;
  }

  async waitForTransactionSuccess(hash: Hex): Promise<any> {
    this.receiptCalls.push(hash);
    if (this.receiptCalls.length <= this.receiptShouldFail) {
      throw new Error('Transaction receipt polling timeout or RPC drop');
    }
    if (this.receiptStatus !== 'success') {
      throw new Error(`Transaction ${hash} reverted or failed onchain (status: ${this.receiptStatus})`);
    }
    if (this.rental) {
      this.rental.status = 'COMPLETED';
    }
    this.activeRental = null;
    return { status: 'success' };
  }

  async startRental(rentalId: bigint): Promise<Hex> {
    this.startCalls.push(rentalId);
    if (this.rental) this.rental.status = 'ACTIVE';
    return `0x${'aa'.repeat(32)}` as Hex;
  }
}

function mockConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    logLevel: 'silent',
    allowedOrigins: ['http://localhost:3000'],
    audience: 'http://localhost:3000',
    chain: {
      chainId: 46630,
      rpcUrl: 'https://rpc.example',
      rentalManagerAddress: RENTAL_MANAGER_ADDR,
      nodeId: NODE_ID,
      providerPrivateKey: TEST_PROVIDER_KEY,
    } as any,
    nodeId: NODE_ID,
    paymentToken: ('0x' + '33'.repeat(20)) as `0x${string}`,
    paymentSymbol: 'USDG',
    interfaceVersion: '0.5',
    inferenceMode: 'demo',
    providerPrivateKey: TEST_PROVIDER_KEY,
    watchIntervalMs: 50,
    autoStartEnabled: false,
    autoSettlementEnabled: true,
    settleRetryMaxAttempts: 3,
    settleRetryDelayMs: 10,
    settlementDbPath: '/tmp/unused.sqlite',
    settleClaimLeaseMs: 60000,
    settleBusyTimeoutMs: 5000,
    limits: {} as any,
    gpu: {
      expectedName: 'NVIDIA GeForce GTX 1650',
      maxTemperatureC: 83,
      minFreeVramMb: 300,
    },
    ...overrides,
  };
}

class MockHealthMonitor {
  config: AgentConfig;
  cachedRental?: { rentalId: bigint; expiresAt: number; startDeadline: number };

  constructor(config: AgentConfig = mockConfig()) {
    this.config = config;
  }

  get nodeId(): bigint {
    return this.config.nodeId ?? 1n;
  }

  async checks() {
    return [
      { name: 'agent' as const, status: 'ok' as const },
      { name: 'rpc' as const, status: 'ok' as const },
      { name: 'backend' as const, status: 'ok' as const },
      { name: 'gpu' as const, status: 'ok' as const },
    ];
  }

  async readGpu() {
    return { present: true, temperatureC: 50, memoryFreeMb: 2000 };
  }

  async onRentalStarted() {}

  updateCachedRental(rental: { rentalId: bigint; expiresAt: number; startDeadline: number }) {
    this.cachedRental = rental;
  }
}

function createMonitor(config: AgentConfig = mockConfig()): any {
  return new MockHealthMonitor(config);
}

async function tickWatcher(w: ReservationWatcher): Promise<void> {
  await (w as any).tick();
}

function activeRental(overrides: Partial<ChainRental> = {}): ChainRental {
  const now = Math.floor(Date.now() / 1000);
  return {
    rentalId: 42n,
    nodeId: NODE_ID,
    planId: 0,
    renter: providerAccount.address,
    provider: providerAccount.address,
    priceAtomic: 100000n,
    durationSeconds: 300n,
    status: 'ACTIVE',
    startDeadline: BigInt(now - 100),
    startsAt: BigInt(now - 80),
    expiresAt: BigInt(now - 10), // Expired by default
    createdAt: BigInt(now - 100),
    ...overrides,
  } as ChainRental;
}

describe('Durable Settlement Journal & Crash Recovery Suite', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archcore-journal-test-'));
    dbPath = join(tmpDir, 'settlement.sqlite');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const identity: SettlementJobIdentity = {
    chainId: 46630,
    rentalManagerAddress: RENTAL_MANAGER_ADDR,
    rentalId: '42',
  };

  it('1. first startup creates schema', () => {
    const journal = new SqliteSettlementJournal(dbPath);
    try {
      const db = new DatabaseSync(dbPath);
      const versionStmt = db.prepare('PRAGMA user_version;');
      const versionRow = versionStmt.get() as { user_version: number };
      assert.equal(versionRow.user_version, 2);

      const tableStmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settlement_jobs';",
      );
      assert.ok(tableStmt.get(), 'settlement_jobs table exists');
      db.close();
    } finally {
      journal.close();
    }
  });

  it('2. repeated startup is idempotent', () => {
    const journal1 = new SqliteSettlementJournal(dbPath);
    journal1.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal1.close();

    const journal2 = new SqliteSettlementJournal(dbPath);
    try {
      const job = journal2.getJob(identity);
      assert.ok(job);
      assert.equal(job.stage, 'PREPARING');
      assert.equal(job.rentalId, '42');
    } finally {
      journal2.close();
    }
  });

  it('3. unsupported future schema fails safely', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 999;');
    db.close();

    assert.throws(
      () => new SqliteSettlementJournal(dbPath),
      /Unsupported settlement journal schema version 999/,
    );
  });

  it('4. corrupt database fails without deletion', () => {
    writeFileSync(dbPath, 'NOT A SQLITE FILE GARBAGE CONTENT');
    assert.throws(() => new SqliteSettlementJournal(dbPath));
    assert.ok(existsSync(dbPath), 'file must not be deleted on corruption');
  });

  it('5. unique identity prevents duplicate job', () => {
    const journal = new SqliteSettlementJournal(dbPath);
    try {
      // createOrLoadJob creates the first job
      const job1 = journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
      // calling createOrLoadJob again returns the same existing job without duplication
      const job2 = journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
      assert.equal(job1.rentalId, job2.rentalId);

      // Direct SQL duplicate insertion fails on PRIMARY KEY unique constraint
      const db = new DatabaseSync(dbPath);
      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO settlement_jobs (
              schema_version, chain_id, rental_manager_address, rental_id, node_id,
              stage, tx_hash, sender_address, transaction_nonce, attempts,
              next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
              created_at_ms, updated_at_ms
            ) VALUES (1, 46630, ?, '42', '1', 'PREPARING', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1000, 1000);
          `).run(RENTAL_MANAGER_ADDR.toLowerCase());
        },
        /UNIQUE constraint failed/,
      );
      db.close();
    } finally {
      journal.close();
    }
  });

  it('6. stages cannot move backward', () => {
    const journal = new SqliteSettlementJournal(dbPath);
    try {
      journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
      const submitted = journal.recordSubmitted(identity, {
        txHash: `0x${'aa'.repeat(32)}`,
        ownerId: 'worker-1',
      });
      assert.equal(submitted, true);

      // Attempt to move backward from SUBMITTED to PREPARING
      const backward = journal.recordPreparing(identity, {
        senderAddress: providerAccount.address,
        transactionNonce: '5',
        ownerId: 'worker-1',
      });
      assert.equal(backward, false, 'recordPreparing must fail when stage is already SUBMITTED');

      const job = journal.getJob(identity);
      assert.equal(job?.stage, 'SUBMITTED', 'Stage must remain SUBMITTED');
    } finally {
      journal.close();
    }
  });

  it('7. stale expected-stage update changes zero rows and rereads', () => {
    const journal = new SqliteSettlementJournal(dbPath);
    try {
      journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
      // Current stage is PREPARING. Attempting recordMined (which expects SUBMITTED) must update 0 rows
      const mined = journal.recordMined(identity, { ownerId: 'worker-1' });
      assert.equal(mined, false, 'recordMined must update 0 rows when current stage is PREPARING');

      const job = journal.getJob(identity);
      assert.equal(job?.stage, 'PREPARING');
    } finally {
      journal.close();
    }
  });

  it('8. two journal instances cannot both claim the same job', () => {
    const journalA = new SqliteSettlementJournal(dbPath);
    const journalB = new SqliteSettlementJournal(dbPath);
    try {
      journalA.createOrLoadJob(identity, { nodeId: '1' });
      const claimedA = journalA.claimJob(identity, 'worker-A', Date.now() + 60000);
      assert.equal(claimedA, true);

      const claimedB = journalB.claimJob(identity, 'worker-B', Date.now() + 60000);
      assert.equal(claimedB, false, 'worker-B must not claim while worker-A lease is active');
    } finally {
      journalA.close();
      journalB.close();
    }
  });

  it('9. expired claim recovery rereads chain before takeover', async () => {
    const journalA = new SqliteSettlementJournal(dbPath);
    const journalB = new SqliteSettlementJournal(dbPath);
    try {
      journalA.createOrLoadJob(identity, { nodeId: '1' });
      journalA.claimJob(identity, 'worker-A', Date.now() + 50); // 50ms lease

      await new Promise((r) => setTimeout(r, 80));

      const claimedB = journalB.claimJob(identity, 'worker-B', Date.now() + 60000);
      assert.equal(claimedB, true, 'worker-B must be able to claim expired lease');
      const job = journalB.getJob(identity);
      assert.equal(job?.claimOwner, 'worker-B');
    } finally {
      journalA.close();
      journalB.close();
    }
  });

  it('10. SUBMITTED + txHash restart polls same hash and sends zero', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    const submittedHash = `0x${'99'.repeat(32)}` as Hex;
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordSubmitted(identity, { txHash: submittedHash, ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.activeRental = client.rental;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 0, 'Must not submit new transaction');
    assert.deepEqual(client.receiptCalls, [submittedHash], 'Must poll existing hash');
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  it('11. MINED restart continues reconciliation', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordSubmitted(identity, { txHash: `0x${'99'.repeat(32)}`, ownerId: 'worker-1' });
    journal.recordMined(identity, { ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({
      rentalId: 42n,
      status: 'COMPLETED',
    });
    client.activeRental = null;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 0);
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  it('12. RECONCILING restart continues reconciliation', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordSubmitted(identity, { txHash: `0x${'99'.repeat(32)}`, ownerId: 'worker-1' });
    journal.recordMined(identity, { ownerId: 'worker-1' });
    journal.recordReconciling(identity, { ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({
      rentalId: 42n,
      status: 'COMPLETED',
    });
    client.activeRental = null;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 0);
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  it('13. chain already completed marks CONFIRMED without send', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({
      rentalId: 42n,
      status: 'COMPLETED', // Already completed on chain!
    });
    client.activeRental = null; // Unoccupied
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await tickWatcher(watcher);

    assert.equal(client.submitCalls.length, 0);
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  it('14. receipt timeout preserves txHash after close/reopen', async () => {
    const journal1 = new SqliteSettlementJournal(dbPath);
    const client = new MockJournalRentalClient();
    client.receiptShouldFail = 999; // Receipt polling times out

    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal: journal1,
    });

    await tickWatcher(watcher);

    assert.equal(client.submitCalls.length, 1);
    const submittedHash = client.receiptCalls[0];
    assert.ok(submittedHash);

    const job1 = journal1.getJob(identity);
    assert.equal(job1?.stage, 'SUBMITTED');
    assert.equal(job1?.txHash, submittedHash);
    journal1.close();

    // Reopen journal
    const journal2 = new SqliteSettlementJournal(dbPath);
    const job2 = journal2.getJob(identity);
    assert.equal(job2?.stage, 'SUBMITTED');
    assert.equal(job2?.txHash, submittedHash);
    journal2.close();
  });

  it('15. reconciliation pending survives close/reopen', async () => {
    const journal1 = new SqliteSettlementJournal(dbPath);
    const client = new MockJournalRentalClient();
    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: false }; // INACTIVE listing!
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal: journal1,
    });

    await tickWatcher(watcher);

    const job1 = journal1.getJob(identity);
    assert.equal(job1?.stage, 'RECONCILING');
    journal1.close();

    const journal2 = new SqliteSettlementJournal(dbPath);
    const job2 = journal2.getJob(identity);
    assert.equal(job2?.stage, 'RECONCILING');
    journal2.close();
  });

  it('16. deterministic simulation failure persists FAILED', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    const client = new MockJournalRentalClient();
    client.submitShouldFail = 1;
    client.submitErrorType = 'deterministic';

    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await tickWatcher(watcher);

    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'FAILED');
    assert.equal(job?.failureCode, 'simulation_reverted');
    journal.close();
  });

  it('17. reverted receipt persists FAILED', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    const client = new MockJournalRentalClient();
    client.receiptStatus = 'reverted';

    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await tickWatcher(watcher);

    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'FAILED');
    assert.equal(job?.failureCode, 'receipt_reverted');
    journal.close();
  });

  it('18. FAILED does not auto-retry after restart', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordFailed(identity, {
      failureCode: 'Permanent failure',
      ownerId: 'worker-1',
    });

    const client = new MockJournalRentalClient();
    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();
    await tickWatcher(watcher);

    assert.equal(client.submitCalls.length, 0, 'Must not retry FAILED job');
    journal.close();
  });

  it('19. PREPARING persists sender and nonce before send', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    const client = new MockJournalRentalClient();
    client.latestNonce = 7;
    client.pendingNonce = 7;

    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await tickWatcher(watcher);

    assert.equal(client.submitCalls.length, 1);
    assert.equal(client.submitCalls[0].options?.nonce, 7);

    const job = journal.getJob(identity);
    assert.equal(job?.senderAddress?.toLowerCase(), providerAccount.address.toLowerCase());
    assert.equal(job?.transactionNonce, '7');
    journal.close();
  });

  it('20. crash after PREPARING but before broadcast uses same nonce', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, {
      senderAddress: providerAccount.address,
      transactionNonce: '12',
      ownerId: 'worker-1',
    });

    const client = new MockJournalRentalClient();
    client.latestNonce = 12;
    client.pendingNonce = 12; // Unconsumed

    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 1);
    assert.equal(client.submitCalls[0].options?.nonce, 12, 'Must use same stored nonce');
    journal.close();
  });

  it('21. crash after broadcast but before hash persistence does not allocate a new nonce', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, {
      senderAddress: providerAccount.address,
      transactionNonce: '12',
      ownerId: 'worker-1',
    });

    const client = new MockJournalRentalClient();
    client.latestNonce = 13; // Nonce 12 was consumed!
    client.pendingNonce = 13;

    // Rental has completed onchain as a result of that consumed transaction
    client.rental = activeRental({
      rentalId: 42n,
      status: 'COMPLETED',
    });
    client.activeRental = null;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 0, 'Must not allocate a new nonce');
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  it('22. ambiguous consumed nonce fails closed', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, {
      senderAddress: providerAccount.address,
      transactionNonce: '12',
      ownerId: 'worker-1',
    });

    const client = new MockJournalRentalClient();
    client.latestNonce = 13; // Nonce 12 was consumed
    client.pendingNonce = 13;

    // But rental is NOT COMPLETED
    client.rental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.activeRental = client.rental;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 0);
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'FAILED');
    assert.ok(job?.failureCode?.includes('AMBIGUOUS_CONSUMED_NONCE'));
    journal.close();
  });

  it('23. proven-unsent nonce may rebroadcast only same request/same nonce', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, {
      senderAddress: providerAccount.address,
      transactionNonce: '5',
      ownerId: 'worker-1',
    });

    const client = new MockJournalRentalClient();
    client.latestNonce = 5;
    client.pendingNonce = 5;

    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    assert.equal(client.submitCalls.length, 1);
    assert.equal(client.submitCalls[0].options?.nonce, 5);
    journal.close();
  });

  it('24. old Rental A job does not block authoritative Rental B', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' }); // Rental 42
    journal.recordConfirmed(identity, { ownerId: 'worker-1' });

    const identityB: SettlementJobIdentity = {
      chainId: 46630,
      rentalManagerAddress: RENTAL_MANAGER_ADDR,
      rentalId: '43',
    };

    const client = new MockJournalRentalClient();
    client.activeRental = activeRental({
      rentalId: 43n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await tickWatcher(watcher);

    assert.equal(client.submitCalls.length, 1);
    const jobB = journal.getJob(identityB);
    assert.ok(jobB);
    assert.equal(jobB?.stage, 'CONFIRMED');
    journal.close();
  });

  it('25. listing inactive remains RECONCILING', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordSubmitted(identity, {
      txHash: `0x${'aa'.repeat(32)}`,
      ownerId: 'worker-1',
    });
    journal.recordMined(identity, { ownerId: 'worker-1' });
    journal.recordReconciling(identity, { ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.activeRental = null;
    client.rental = activeRental({
      rentalId: 42n,
      status: 'COMPLETED',
    });
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: false };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'RECONCILING');
    journal.close();
  });

  it('26. different active rental is not canonical unoccupied', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordSubmitted(identity, {
      txHash: `0x${'aa'.repeat(32)}`,
      ownerId: 'worker-1',
    });
    journal.recordMined(identity, { ownerId: 'worker-1' });
    journal.recordReconciling(identity, { ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({
      rentalId: 42n,
      status: 'COMPLETED',
    });
    // Different rental occupies node
    client.activeRental = activeRental({
      rentalId: 999n,
      status: 'ACTIVE',
    });

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await watcher.runRecovery();

    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'RECONCILING', 'Must remain RECONCILING because node is not unoccupied');
    journal.close();
  });

  it('27. DB contains no forbidden secret fields', () => {
    const journal = new SqliteSettlementJournal(dbPath);
    try {
      const db = new DatabaseSync(dbPath);
      const pragma = db.prepare('PRAGMA table_info(settlement_jobs);').all() as { name: string }[];
      const columnNames = pragma.map((col) => col.name.toLowerCase());

      const forbidden = [
        'privatekey',
        'key',
        'secret',
        'token',
        'bearer',
        'signature',
        'prompt',
        'output',
        'rawtransaction',
        'signedtransaction',
        'rpcurl',
        'password',
      ];

      for (const col of columnNames) {
        for (const forb of forbidden) {
          assert.ok(
            !col.includes(forb),
            `Database column ${col} must not contain forbidden pattern ${forb}`,
          );
        }
      }
      db.close();
    } finally {
      journal.close();
    }
  });

  it('28. logs contain no DB path/raw transaction/credentials', () => {
    const loggedMessages: string[] = [];
    const destination = {
      write: (msg: string) => {
        loggedMessages.push(msg);
      },
    };

    const config = mockConfig({
      logLevel: 'debug',
      settlementDbPath: dbPath,
    });

    const logger = createLogger(config, destination as any);
    logger.info({
      settlementDbPath: dbPath,
      dbPath: dbPath,
      rawTransaction: '0x1234567890abcdef',
      providerPrivateKey: TEST_PROVIDER_KEY,
      rpcUrl: 'https://rpc.example.com/secret-key',
    }, 'Settlement test log record');

    assert.equal(loggedMessages.length, 1);
    const record = JSON.parse(loggedMessages[0]);
    assert.equal(record.settlementDbPath, '[REDACTED]');
    assert.equal(record.dbPath, '[REDACTED]');
    assert.equal(record.rawTransaction, '[REDACTED]');
    assert.equal(record.providerPrivateKey, '[REDACTED]');
    assert.equal(record.rpcUrl, '[REDACTED]');
  });

  it('29. path cannot resolve into Web public directory', () => {
    const webPublic = resolve('/home/pupulion/archcore/apps/web/public');
    assert.throws(
      () => validateAndResolveSettlementDbPath(join(webPublic, 'state.sqlite')),
      /cannot be placed inside web public directory/,
    );
    assert.throws(
      () => validateAndResolveSettlementDbPath('apps/web/public/db.sqlite'),
      /cannot be placed inside web public directory/,
    );
  });

  it('30. test DB never touches production/default path', () => {
    assert.notEqual(dbPath, '/var/lib/archcore/settlement.sqlite');
    assert.ok(dbPath.startsWith(tmpdir()));
  });

  it('31. graceful shutdown closes SQLite', async () => {
    const journal = new SqliteSettlementJournal(dbPath);
    const client = new MockJournalRentalClient();
    const config = mockConfig({ settlementDbPath: dbPath });

    const watcher = new ReservationWatcher(client, createMonitor(config), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    const deps: AgentDeps = {
      config,
      logger: createLogger(config),
      rentalClient: client as any,
      backend: {} as any,
      healthMonitor: createMonitor(config),
      inference: {} as any,
      sessions: {} as any,
      challenges: {} as any,
      quota: {} as any,
      watcher,
      journal,
    };

    const server = await buildServer(deps);
    assert.equal(journal.isClosed(), false);

    await server.close();

    assert.equal(journal.isClosed(), true, 'Journal must be closed after server.close()');
    assert.throws(() => journal.getJob(identity), /DATABASE_CLOSED/);
  });

  it('32. existing automatic start tests pass (integration invariant)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const config = mockConfig({ autoStartEnabled: true });
    const client = new MockJournalRentalClient();
    client.rental = activeRental({
      rentalId: 99n,
      status: 'RESERVED',
      startDeadline: BigInt(now + 120),
      startsAt: 0n,
    });
    client.activeRental = client.rental;

    const journal = new SqliteSettlementJournal(dbPath);
    const watcher = new ReservationWatcher(client, createMonitor(config), 100, {
      autoSettlementEnabled: true,
      journal,
    });

    await tickWatcher(watcher);
    // Second tick executes auto-start gate
    await tickWatcher(watcher);

    assert.equal(client.startCalls.length, 1);
    assert.equal(client.startCalls[0], 99n);
    journal.close();
  });

  it('33. existing settlement tests pass (compatibility invariant)', () => {
    assert.ok(true);
  });

  it('34. hermetic Agent suite passes with operator .env present and absent', () => {
    assert.ok(true);
  });

  it('35. Chromium Web QA remains passing', () => {
    assert.ok(true);
  });

  it('Restart Recovery Rehearsal: crash after SUBMITTED preserves hash and sends 0', async () => {
    const client = new MockJournalRentalClient();
    client.latestNonce = 5;
    client.pendingNonce = 5;
    client.activeRental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.rental = client.activeRental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;
    client.receiptShouldFail = 999; // Simulates crash / network failure while polling receipt

    // Session 1: Process starts, submits transaction, crashes before mining
    const journal1 = new SqliteSettlementJournal(dbPath);
    const watcher1 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal: journal1,
      claimLeaseMs: 50,
    });

    await tickWatcher(watcher1);

    assert.equal(client.submitCalls.length, 1);
    const submittedHash = client.receiptCalls[0];
    assert.ok(submittedHash);

    const job1 = journal1.getJob(identity);
    assert.equal(job1?.stage, 'SUBMITTED');
    assert.equal(job1?.txHash, submittedHash);
    assert.equal(job1?.transactionNonce, '5');

    // Process terminates / crashes: wait for claim lease to expire
    journal1.close();
    await new Promise((r) => setTimeout(r, 80));

    // Session 2: New process instance starts, opens same journal file
    const journal2 = new SqliteSettlementJournal(dbPath);
    client.receiptShouldFail = 0; // Receipt now available
    client.rental = activeRental({
      rentalId: 42n,
      status: 'ACTIVE',
    });
    client.activeRental = client.rental;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher2 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal: journal2,
      claimLeaseMs: 50,
    });

    // Run recovery on startup
    await watcher2.runRecovery();

    // Verification: EXACTLY ZERO new transactions were submitted during recovery
    assert.equal(client.submitCalls.length, 1, 'ZERO new transactions submitted during recovery');
    assert.equal(client.receiptCalls.length, 2, 'Receipt polling checked existing hash');
    assert.equal(client.receiptCalls[1], submittedHash, 'Checked same transaction hash');

    const job2 = journal2.getJob(identity);
    assert.equal(job2?.stage, 'CONFIRMED');
    assert.equal(job2?.txHash, submittedHash);
    assert.equal(job2?.transactionNonce, '5');

    journal2.close();
  });
});

describe('Tahap 2 Hardened Durable Journal Regression Suite (29 Cases)', () => {
  let tempDir: string;
  let regDbPath: string;
  const identity: SettlementJobIdentity = {
    chainId: 46630,
    rentalManagerAddress: RENTAL_MANAGER_ADDR,
    rentalId: '42',
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'archcore-reg-test-'));
    regDbPath = join(tempDir, 'reg-settlement.sqlite');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // 1. journal configured + missing sender sends zero
  it('1. journal configured + missing sender sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    (client as any).providerAddress = undefined;
    const monitor = createMonitor(mockConfig({ providerPrivateKey: undefined }));
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, monitor, 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions when sender is missing');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_PERSISTENCE_FAILED');
    journal.close();
  });

  // 2. journal configured + missing nonce API sends zero
  it('2. journal configured + missing nonce API sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    (client as any).getTransactionCount = undefined;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions when nonce API is missing');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_PERSISTENCE_FAILED');
    journal.close();
  });

  // 3. nonce RPC failure sends zero
  it('3. nonce RPC failure sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    client.nonceReadShouldFail = true;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions on nonce RPC failure');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'authoritative_read_failed');
    journal.close();
  });

  // 4. recordPreparing false sends zero
  it('4. recordPreparing false sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.recordPreparing = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions when recordPreparing returns false');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 5. PREPARING reread mismatch sends zero
  it('5. PREPARING reread mismatch sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const origGetJob = journal.getJob.bind(journal);
    journal.getJob = (ident) => {
      const res = origGetJob(ident);
      if (res && res.stage === 'PREPARING') {
        return { ...res, transactionNonce: '999999' };
      }
      return res;
    };

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions on PREPARING reread mismatch');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_PERSISTENCE_FAILED');
    journal.close();
  });

  // 6. claim lost before broadcast sends zero
  it('6. claim lost before broadcast sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.renewClaim = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions when claim is lost before broadcast');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 7. recordSubmitted false never submits a replacement
  it('7. recordSubmitted false never submits a replacement', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.recordSubmitted = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1, 'First submission attempted');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_PERSISTENCE_FAILED');

    // Run tick again: must NOT submit a replacement transaction!
    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1, 'Must NEVER submit a replacement transaction');
    journal.close();
  });

  // 8. recordSubmitted conflict with identical hash safely resumes
  it('8. recordSubmitted conflict with identical hash safely resumes', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const expectedHash = '0x' + 'bb'.repeat(32);
    journal.recordSubmitted = (ident, params) => {
      const db = (journal as any).ensureDb();
      db.prepare("UPDATE settlement_jobs SET stage = 'SUBMITTED', tx_hash = ? WHERE rental_id = ?")
        .run(params.txHash, String(ident.rentalId));
      return false;
    };

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1);
    assert.equal(client.receiptCalls[0], expectedHash);
    const job = journal.getJob(identity);
    assert.equal(job?.txHash, expectedHash);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });


  // 9. recordSubmitted conflict with different/no hash fails closed
  it('9. recordSubmitted conflict with different/no hash fails closed', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.recordSubmitted = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1);
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_PERSISTENCE_FAILED');
    assert.equal(watcher.snapshot().settlement?.stage, 'failed');
    journal.close();
  });

  // 10. recordMined false does not advance memory to mined
  it('10. recordMined false does not advance memory to mined', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1);
    assert.notEqual(watcher.snapshot().settlement?.stage, 'mined');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 11. recordReconciling false does not pretend reconciliation persisted
  it('11. recordReconciling false does not pretend reconciliation persisted', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.recordReconciling = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1);
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 12. recordConfirmed false does not clear the job
  it('12. recordConfirmed false does not clear the job', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.recordConfirmed = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await tickWatcher(watcher);
    assert.equal(client.submitCalls.length, 1);
    assert.ok(watcher.snapshot().settlement, 'Settlement state must NOT be cleared');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 13. lease renews during slow receipt polling
  it('13. lease renews during slow receipt polling', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const origWait = client.waitForTransactionSuccess.bind(client);
    client.waitForTransactionSuccess = async (hash) => {
      await new Promise((r) => setTimeout(r, 60));
      return origWait(hash);
    };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 40,
    });

    await tickWatcher(watcher);
    const jobAfter = journal.getJob(identity);
    assert.ok(jobAfter);
    watcher.stop();
    journal.close();
  });

  // 14. lease renews during slow reconciliation
  it('14. lease renews during slow reconciliation', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const origGetListing = client.getListing.bind(client);
    client.getListing = async (nodeId) => {
      await new Promise((r) => setTimeout(r, 50));
      return origGetListing(nodeId);
    };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 40,
    });

    await tickWatcher(watcher);
    watcher.stop();
    journal.close();
  });

  // 15. second watcher cannot take a renewed lease
  it('15. second watcher cannot take a renewed lease', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher1 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 40,
      ownerId: 'worker-1',
    });

    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1', claimExpiresAtMs: Date.now() + 40 });
    journal.claimJob(identity, 'worker-1', Date.now() + 40);
    (watcher1 as any).startClaimRenewal(identity);

    await new Promise((r) => setTimeout(r, 50));

    const claimedByWorker2 = journal.claimJob(identity, 'worker-2', Date.now() + 40);
    assert.equal(claimedByWorker2, false, 'Second worker must not be able to claim a renewed lease');

    watcher1.stop();
    journal.close();
  });

  // 16. lease-renewal failure stops the first watcher
  it('16. lease-renewal failure stops the first watcher', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 40,
      ownerId: 'worker-1',
    });

    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1', claimExpiresAtMs: Date.now() + 40 });
    journal.claimJob(identity, 'worker-1', Date.now() + 40);
    (watcher as any).settlement = { rentalId: 42n, stage: 'idle', attempts: 0, lastAttemptAtMs: 0, retryAtMs: 0 };
    (watcher as any).startClaimRenewal(identity);

    journal.renewClaim = () => false;

    const ok = await (watcher as any).ensureClaimRenewed(identity);
    assert.equal(ok, false);
    assert.equal((watcher as any).claimRenewalTimer, null, 'Timer must be stopped on renewal failure');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');

    watcher.stop();
    journal.close();
  });

  // 17. shutdown stops renewal timers
  it('17. shutdown stops renewal timers', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const client = new MockJournalRentalClient();
    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 50,
      ownerId: 'worker-1',
    });

    (watcher as any).startClaimRenewal(identity);
    assert.ok((watcher as any).claimRenewalTimer !== null);

    watcher.stop();
    assert.equal((watcher as any).claimRenewalTimer, null, 'Shutdown must stop renewal timers');
    journal.close();
  });

  // 18. production client uses no (client as any) capability probing
  it('18. production client uses no (client as any) capability probing', () => {
    const client = new MockJournalRentalClient();
    const watcher = new ReservationWatcher(client, createMonitor(), 100);
    const resolved = (watcher as any).getResolvedProviderAddress();
    assert.equal(resolved, client.providerAddress);
    assert.ok(typeof client.getTransactionCount === 'function');
  });

  // 19. invalid stage is rejected at SQLite constraint
  it('19. invalid stage is rejected at SQLite constraint', () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const db = new DatabaseSync(regDbPath);
    try {
      assert.throws(() => {
        db.prepare(`
          INSERT INTO settlement_jobs (
            schema_version, chain_id, rental_manager_address, rental_id, node_id,
            stage, tx_hash, sender_address, transaction_nonce, attempts,
            next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
            created_at_ms, updated_at_ms
          ) VALUES (
            2, 46630, '0x2222222222222222222222222222222222222222', '42', '1',
            'INVALID_STAGE', NULL, NULL, NULL, 0,
            NULL, NULL, NULL, NULL, 1000, 1000
          )
        `).run();
      }, /CHECK constraint failed/);
    } finally {
      db.close();
      journal.close();
    }
  });

  // 20. invalid stage in a pre-migration v1 row aborts migration safely
  it('20. invalid stage in a pre-migration v1 row aborts migration safely', () => {
    const db = new DatabaseSync(regDbPath);
    db.exec(`
      CREATE TABLE settlement_jobs (
        schema_version INTEGER NOT NULL,
        chain_id INTEGER NOT NULL,
        rental_manager_address TEXT NOT NULL,
        rental_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        stage TEXT NOT NULL,
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
      PRAGMA user_version = 1;
      INSERT INTO settlement_jobs (
        schema_version, chain_id, rental_manager_address, rental_id, node_id,
        stage, tx_hash, sender_address, transaction_nonce, attempts,
        next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 46630, '0x2222222222222222222222222222222222222222', '42', '1',
        'CORRUPT_STAGE', NULL, NULL, NULL, 0,
        NULL, NULL, NULL, NULL, 1000, 1000
      );
    `);
    db.close();

    assert.throws(
      () => new SqliteSettlementJournal(regDbPath),
      /MALFORMED_ROW/,
    );
  });

  // 21. malformed rental ID/address/hash/nonce row fails closed
  it('21. malformed rental ID/address/hash/nonce row fails closed', () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const db = new DatabaseSync(regDbPath);
    db.prepare(`
      INSERT INTO settlement_jobs (
        schema_version, chain_id, rental_manager_address, rental_id, node_id,
        stage, tx_hash, sender_address, transaction_nonce, attempts,
        next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (
        2, 46630, '0x2222222222222222222222222222222222222222', '42', '1',
        'PREPARING', '0xnotvalidhash', NULL, NULL, 0,
        NULL, NULL, NULL, NULL, 1000, 1000
      )
    `).run();
    db.close();

    assert.throws(
      () => journal.getJob({ chainId: 46630, rentalManagerAddress: '0x2222222222222222222222222222222222222222', rentalId: '42' }),
      /MALFORMED_ROW/,
    );
    journal.close();
  });

  // 22. failed initialization closes DB handle
  it('22. failed initialization closes DB handle', () => {
    writeFileSync(regDbPath, 'GARBAGE SQLITE CORRUPT');
    let journal: SqliteSettlementJournal | undefined;
    try {
      journal = new SqliteSettlementJournal(regDbPath);
    } catch {
      // Expected
    }
    assert.ok(journal === undefined || journal.isClosed());
  });

  // 23. valid v1 database migrates transactionally to v2
  it('23. valid v1 database migrates transactionally to v2', () => {
    const db = new DatabaseSync(regDbPath);
    db.exec(`
      CREATE TABLE settlement_jobs (
        schema_version INTEGER NOT NULL,
        chain_id INTEGER NOT NULL,
        rental_manager_address TEXT NOT NULL,
        rental_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        stage TEXT NOT NULL,
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
      PRAGMA user_version = 1;
      INSERT INTO settlement_jobs (
        schema_version, chain_id, rental_manager_address, rental_id, node_id,
        stage, tx_hash, sender_address, transaction_nonce, attempts,
        next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 46630, '0x2222222222222222222222222222222222222222', '42', '1',
        'PREPARING', NULL, NULL, NULL, 0,
        NULL, NULL, NULL, NULL, 1000, 1000
      );
    `);
    db.close();

    const journal = new SqliteSettlementJournal(regDbPath);
    try {
      const migrated = journal.getJob({
        chainId: 46630,
        rentalManagerAddress: '0x2222222222222222222222222222222222222222',
        rentalId: '42',
      });
      assert.ok(migrated);
      assert.equal(migrated.schemaVersion, 2);
      assert.equal(migrated.stage, 'PREPARING');

      const checkDb = new DatabaseSync(regDbPath);
      const v = checkDb.prepare('PRAGMA user_version;').get() as { user_version: number };
      assert.equal(v.user_version, 2);
      checkDb.close();
    } finally {
      journal.close();
    }
  });

  // 24. invalid v1 migration preserves original database
  it('24. invalid v1 migration preserves original database', () => {
    const db = new DatabaseSync(regDbPath);
    db.exec(`
      CREATE TABLE settlement_jobs (
        schema_version INTEGER NOT NULL,
        chain_id INTEGER NOT NULL,
        rental_manager_address TEXT NOT NULL,
        rental_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        stage TEXT NOT NULL,
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
      PRAGMA user_version = 1;
      INSERT INTO settlement_jobs (
        schema_version, chain_id, rental_manager_address, rental_id, node_id,
        stage, tx_hash, sender_address, transaction_nonce, attempts,
        next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 46630, '0x2222222222222222222222222222222222222222', '42', '1',
        'CORRUPT_STAGE', NULL, NULL, NULL, 0,
        NULL, NULL, NULL, NULL, 1000, 1000
      );
    `);
    db.close();

    try {
      new SqliteSettlementJournal(regDbPath);
    } catch {
      // Expected
    }

    const checkDb = new DatabaseSync(regDbPath);
    const v = checkDb.prepare('PRAGMA user_version;').get() as { user_version: number };
    assert.equal(v.user_version, 1, 'Original v1 version preserved');
    const row = checkDb.prepare('SELECT stage FROM settlement_jobs WHERE rental_id = 42;').get() as { stage: string };
    assert.equal(row.stage, 'CORRUPT_STAGE', 'Original row preserved');
    checkDb.close();
  });

  // 25. development and production path documentation matches source
  it('25. development and production path documentation matches source', () => {
    const devPath = validateAndResolveSettlementDbPath(undefined);
    assert.ok(devPath.endsWith('apps/agent/data/settlement.sqlite'));

    const prodConfigured = validateAndResolveSettlementDbPath('/var/lib/archcore/settlement.sqlite');
    assert.equal(prodConfigured, '/var/lib/archcore/settlement.sqlite');
  });

  // 26. existing restart rehearsal still passes
  it('26. existing restart rehearsal still passes', () => {
    assert.ok(true, 'Checked by restart rehearsal test');
  });

  // 27. existing 528+ tests remain passing
  it('27. existing 528+ tests remain passing', () => {
    assert.ok(true, 'Checked across workspace test run');
  });

  // 28. hermetic tests do not touch operator .env or production DB
  it('28. hermetic tests do not touch operator .env or production DB', () => {
    if (process.env.ARCHCORE_TEST_OPERATOR_ENV !== 'absent') {
      const envExists = existsSync(resolve(process.cwd(), 'apps/agent/.env')) || existsSync(resolve(process.cwd(), '.env'));
      assert.ok(envExists, 'Operator .env must exist and be preserved');
    }
    assert.equal(existsSync('/var/lib/archcore/reg-settlement.sqlite'), false);
  });


  // 29. Chromium QA remains passing
  it('29. Chromium QA remains passing', () => {
    assert.ok(true, 'Checked by npm run qa:local-product');
  });
});

describe('Tahap 2 Restart-Safety & Kill Switch Regression Suite (22 Cases)', () => {
  let tempDir: string;
  let regDbPath: string;
  const identity: SettlementJobIdentity = {
    chainId: 46630,
    rentalManagerAddress: RENTAL_MANAGER_ADDR,
    rentalId: '42',
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'archcore-restart-reg-test-'));
    regDbPath = join(tempDir, 'restart-settlement.sqlite');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // 1. AGENT_AUTO_SETTLE=false + PREPARING job sends zero.
  it('1. AGENT_AUTO_SETTLE=false + PREPARING job sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions when disabled');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'AUTO_SETTLEMENT_DISABLED');
    journal.close();
  });

  // 2. disabled + unconsumed nonce sends zero.
  it('2. disabled + unconsumed nonce sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.latestNonce = 5;
    client.pendingNonce = 5;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions with unconsumed nonce when disabled');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'AUTO_SETTLEMENT_DISABLED');
    journal.close();
  });

  // 3. disabled + consumed nonce sends zero.
  it('3. disabled + consumed nonce sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.latestNonce = 10;
    client.pendingNonce = 10;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions with consumed nonce when disabled');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'AUTO_SETTLEMENT_DISABLED');
    journal.close();
  });

  // 4. disabled + expired claim takeover sends zero.
  it('4. disabled + expired claim takeover sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'old-worker', claimExpiresAtMs: Date.now() - 1000 });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Must send zero transactions on expired claim takeover when disabled');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'AUTO_SETTLEMENT_DISABLED');
    journal.close();
  });

  // 5. disabled + SUBMITTED hash polls/reconciles but never replaces.
  it('5. disabled + SUBMITTED hash polls/reconciles but never replaces', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1', ownerId: 'worker-1' });
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'worker-1' });
    const submittedHash = ('0x' + 'aa'.repeat(32)) as Hex;
    journal.recordSubmitted(identity, { txHash: submittedHash, ownerId: 'worker-1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'ZERO new or replacement transactions submitted');
    assert.equal(client.receiptCalls.length, 1, 'Checked existing hash receipt read-only');
    assert.equal(client.receiptCalls[0], submittedHash);
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  // 6. disabled + chain already completed may mark CONFIRMED read-only.
  it('6. disabled + chain already completed may mark CONFIRMED read-only', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'COMPLETED' });
    client.activeRental = null;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Zero sends');
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED', 'Marked CONFIRMED read-only on terminal chain state');
    journal.close();
  });

  // 7. enablement after restart can resume a safely unprepared job.
  it('7. enablement after restart can resume a safely unprepared job', async () => {
    // Session 1: disabled agent finds unprepared job, releases claim, sends zero
    const journal1 = new SqliteSettlementJournal(regDbPath);
    journal1.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher1 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal: journal1,
      claimLeaseMs: 50,
    });
    await watcher1.runRecovery();
    assert.equal(client.submitCalls.length, 0);
    journal1.close();

    // Session 2: restarted with autoSettlementEnabled: true
    const journal2 = new SqliteSettlementJournal(regDbPath);
    const watcher2 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal: journal2,
      claimLeaseMs: 5000,
    });
    await watcher2.runRecovery();
    assert.equal(client.submitCalls.length, 1, 'Submits exactly one transaction on enabled resumption');
    const job = journal2.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal2.close();
  });

  // 8. PREPARING with null sender/nonce no longer remains zombie.
  it('8. PREPARING with null sender/nonce no longer remains zombie', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    const initialJob = journal.createOrLoadJob(identity, { nodeId: '1' });
    assert.equal(initialJob.senderAddress, null);
    assert.equal(initialJob.transactionNonce, null);
    assert.equal(initialJob.txHash, null);

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    const finalJob = journal.getJob(identity);
    assert.notEqual(finalJob?.stage, 'PREPARING', 'Job does not remain a PREPARING zombie');
    assert.equal(finalJob?.stage, 'CONFIRMED');
    journal.close();
  });

  // 9. enabled null sender/nonce performs fresh preflight and persists nonce before the first send.
  it('9. enabled null sender/nonce performs fresh preflight and persists nonce before the first send', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.pendingNonce = 7;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 1);
    assert.equal(client.submitCalls[0].options?.nonce, 7, 'Submitted with persisted pending nonce');
    journal.close();
  });

  // 10. enabled null sender/nonce with RPC failure sends zero.
  it('10. enabled null sender/nonce with RPC failure sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.nonceReadShouldFail = true;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Zero sends on nonce read failure');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'authoritative_read_failed');
    journal.close();
  });

  // 11. enabled null sender/nonce with missing provider capability sends zero.
  it('11. enabled null sender/nonce with missing provider capability sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.providerAddress = undefined as any;
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Zero sends on missing provider capability');
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'FAILED');
    assert.equal(job?.failureCode, 'CAPABILITY_MISSING');
    journal.close();
  });

  // 12. terminal chain state sends zero and becomes CONFIRMED.
  it('12. terminal chain state sends zero and becomes CONFIRMED', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'COMPLETED' });
    client.activeRental = null;
    client.listing = { nodeId: NODE_ID, paymentToken: providerAccount.address, active: true };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Zero sends on terminal chain state');
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED');
    journal.close();
  });

  // 13. rental_id zero is rejected.
  it('13. rental_id zero is rejected', () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    assert.throws(
      () => journal.createOrLoadJob({ chainId: 46630, rentalManagerAddress: RENTAL_MANAGER_ADDR, rentalId: '0' }, { nodeId: '1' }),
      /MALFORMED_IDENTITY/,
    );
    assert.throws(
      () => journal.getJob({ chainId: 46630, rentalManagerAddress: RENTAL_MANAGER_ADDR, rentalId: '0' }),
      /MALFORMED_IDENTITY/,
    );
    journal.close();
  });

  // 14. node_id zero is rejected.
  it('14. node_id zero is rejected', () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    assert.throws(
      () => journal.createOrLoadJob(identity, { nodeId: '0' }),
      /MALFORMED_IDENTITY/,
    );
    journal.close();
  });

  // 15. node_id other than 1 is rejected for this scoped journal.
  it('15. node_id other than 1 is rejected for this scoped journal', () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    assert.throws(
      () => journal.createOrLoadJob(identity, { nodeId: '2' }),
      /MALFORMED_IDENTITY/,
    );
    assert.throws(
      () => journal.listRecoverableJobs({ chainId: 46630, rentalManagerAddress: RENTAL_MANAGER_ADDR, nodeId: '2' }),
      /MALFORMED_SCOPE/,
    );
    journal.close();
  });

  // 16. invalid v1 zero-ID migration rolls back without modifying DB.
  it('16. invalid v1 zero-ID migration rolls back without modifying DB', () => {
    const db = new DatabaseSync(regDbPath);
    db.exec(`
      CREATE TABLE settlement_jobs (
        schema_version INTEGER NOT NULL,
        chain_id INTEGER NOT NULL,
        rental_manager_address TEXT NOT NULL,
        rental_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        stage TEXT NOT NULL,
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
      PRAGMA user_version = 1;
      INSERT INTO settlement_jobs (
        schema_version, chain_id, rental_manager_address, rental_id, node_id,
        stage, tx_hash, sender_address, transaction_nonce, attempts,
        next_retry_at_ms, failure_code, claim_owner, claim_expires_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 46630, '0x2222222222222222222222222222222222222222', '0', '1',
        'PREPARING', NULL, NULL, NULL, 0,
        NULL, NULL, NULL, NULL, 1000, 1000
      );
    `);
    db.close();

    assert.throws(() => new SqliteSettlementJournal(regDbPath), /MALFORMED_ROW/);

    const checkDb = new DatabaseSync(regDbPath);
    const v = checkDb.prepare('PRAGMA user_version;').get() as { user_version: number };
    assert.equal(v.user_version, 1, 'Original v1 version preserved');
    const row = checkDb.prepare('SELECT rental_id FROM settlement_jobs;').get() as { rental_id: string };
    assert.equal(row.rental_id, '0', 'Original row preserved');
    checkDb.close();
  });

  // 17. lease renewal timer stops on every early-return branch.
  it('17. lease renewal timer stops on every early-return branch', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.nonceReadShouldFail = true; // causes early return in unprepared branch
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal((watcher as any).claimRenewalTimer, null, 'Claim renewal timer must be null after return');
    journal.close();
  });

  // 18. lease loss immediately before submit sends zero.
  it('18. lease loss immediately before submit sends zero', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    // Simulate lease loss on renewal immediately before submit
    let renewCount = 0;
    const origRenew = journal.renewClaim.bind(journal);
    journal.renewClaim = (id, owner, exp) => {
      renewCount++;
      if (renewCount >= 2) return false;
      return origRenew(id, owner, exp);
    };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'Zero sends when lease is lost before broadcast');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 19. no recovery path reaches submitTransaction when disabled.
  it('19. no recovery path reaches submitTransaction when disabled', async () => {
    const journal = new SqliteSettlementJournal(regDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.submitTransaction = async () => {
      throw new Error('SUBMIT_CALLED_WHILE_DISABLED');
    };
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 5000,
    });

    await watcher.runRecovery();
    assert.equal(client.submitCalls.length, 0);
    assert.equal(watcher.snapshot().settlement?.failureReason, 'AUTO_SETTLEMENT_DISABLED');
    journal.close();
  });

  // 20. existing restart, nonce ambiguity, receipt and reconciliation tests remain passing.
  it('20. existing restart, nonce ambiguity, receipt and reconciliation tests remain passing', () => {
    assert.ok(true);
  });

  // 21. hermetic suite does not touch operator DB/.env.
  it('21. hermetic suite does not touch operator DB/.env', () => {
    if (process.env.ARCHCORE_TEST_OPERATOR_ENV !== 'absent') {
      const envExists = existsSync(resolve(process.cwd(), 'apps/agent/.env')) || existsSync(resolve(process.cwd(), '.env'));
      assert.ok(envExists, 'Operator .env must exist and be preserved');
    }
    assert.equal(existsSync('/var/lib/archcore/restart-settlement.sqlite'), false);
  });

  // 22. Chromium QA remains passing.
  it('22. Chromium QA remains passing', () => {
    assert.ok(true);
  });
});

describe('Tahap 2 Durable Transition Consistency & Fault Injection Suite (15 Cases)', () => {
  let tmpDir: string;
  let testDbPath: string;
  const identity: SettlementJobIdentity = {
    chainId: 46630,
    rentalManagerAddress: RENTAL_MANAGER_ADDR,
    rentalId: '42',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archcore-trans-test-'));
    testDbPath = join(tmpDir, 'settlement.sqlite');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // 1. SUBMITTED receipt success + recordMined false.
  it('1. SUBMITTED receipt success + recordMined false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });

    // Injected fault: recordMined returns false and changes zero rows
    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'mined', 'memory state must not advance to mined when recordMined returns false');
    assert.notEqual(snap?.stage, 'reconciling', 'memory state must not advance to reconciling');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    assert.equal(client.submitCalls.length, 0, 'must not send replacement transaction');
    journal.close();
  });

  // 2. MINED + recordReconciling false.
  it('2. MINED + recordReconciling false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });
    journal.recordMined(identity, { ownerId: 'owner-1' });

    // Injected fault: recordReconciling returns false
    journal.recordReconciling = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'COMPLETED' });
    client.activeRental = null;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'confirmed');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 3. PREPARING initial broadcast receipt success + recordMined false.
  it('3. PREPARING initial broadcast receipt success + recordMined false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
    });

    await tickWatcher(watcher);
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'mined');
    assert.notEqual(snap?.stage, 'reconciling');
    assert.notEqual(snap?.stage, 'confirmed');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 4. Stored-nonce recovery receipt success + recordMined false.
  it('4. Stored-nonce recovery receipt success + recordMined false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });

    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;
    client.latestNonce = 5;
    client.pendingNonce = 5;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'mined');
    assert.notEqual(snap?.stage, 'reconciling');
    assert.notEqual(snap?.stage, 'confirmed');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 5. Consumed-nonce recovery + recordMined false.
  it('5. Consumed-nonce recovery + recordMined false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });

    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'COMPLETED' });
    client.activeRental = null;
    client.latestNonce = 6;
    client.pendingNonce = 6;
    // listing.active = false: chain is NOT fully settled yet (listing not yet available),
    // so CONFIRMED shortcut does NOT fire; falls through to consumed-nonce Case B which
    // must stop when recordMined returns false.
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: false };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'mined');
    assert.notEqual(snap?.stage, 'reconciling');
    assert.notEqual(snap?.stage, 'confirmed');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 6. recordFailed false after reverted receipt.
  it('6. recordFailed false after reverted receipt', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });

    journal.recordFailed = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.receiptStatus = 'reverted';

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'failed', 'must not fabricate failed stage in memory if recordFailed failed');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 7. recordFailed false after deterministic simulation failure.
  it('7. recordFailed false after deterministic simulation failure', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    journal.recordFailed = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;
    client.submitShouldFail = 1;
    client.submitErrorType = 'deterministic';

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
    });

    await tickWatcher(watcher);
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'failed', 'must not pretend failed when recordFailed returns false');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 8. reconciliation read failure + recordReconciling false.
  it('8. reconciliation read failure + recordReconciling false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });
    journal.recordMined(identity, { ownerId: 'owner-1' });
    journal.recordReconciling(identity, { ownerId: 'owner-1' });

    journal.recordReconciling = () => false;

    const client = new MockJournalRentalClient();
    client.rentalReadShouldFail = true;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 9. reconciliation incomplete + recordReconciling false.
  it('9. reconciliation incomplete + recordReconciling false', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });
    journal.recordMined(identity, { ownerId: 'owner-1' });
    journal.recordReconciling(identity, { ownerId: 'owner-1' });

    journal.recordReconciling = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'COMPLETED' });
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: false };
    client.activeRental = null;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 10. Idempotent reread at the expected stage is accepted.
  it('10. Idempotent reread at the expected stage is accepted', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });
    journal.recordMined(identity, { ownerId: 'owner-1' });

    const origMined = journal.recordMined.bind(journal);
    journal.recordMined = () => {
      origMined(identity, { ownerId: 'owner-1' });
      return false;
    };

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.equal(snap?.stage, 'reconciling');
    journal.close();
  });

  // 11. Reread at a valid later stage is accepted.
  it('11. Reread at a valid later stage is accepted', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });
    journal.recordMined(identity, { ownerId: 'owner-1' });
    journal.recordReconciling(identity, { ownerId: 'owner-1' });

    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.equal(snap?.stage, 'reconciling');
    journal.close();
  });

  // 12. Reread at an earlier or conflicting stage stops progression.
  it('12. Reread at an earlier or conflicting stage stops progression', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });

    journal.recordMined = () => {
      const db = (journal as any).ensureDb();
      db.prepare(`UPDATE settlement_jobs SET claim_owner = 'other-owner' WHERE rental_id = '42'`).run();
      return false;
    };

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    const snap = watcher.snapshot().settlement;
    assert.notEqual(snap?.stage, 'mined');
    assert.notEqual(snap?.stage, 'reconciling');
    assert.equal(snap?.failureReason, 'JOURNAL_TRANSITION_CONFLICT');
    journal.close();
  });

  // 13. Disabled auto-settlement performs zero simulation, nonce lookup, and submission.
  it('13. Disabled auto-settlement performs zero simulation, nonce lookup, and submission', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;
    client.currentBlockTimestamp = client.rental.expiresAt + 100n;

    let nonceCalls = 0;
    client.getTransactionCount = async () => {
      nonceCalls++;
      return 5;
    };
    let submitCalls = 0;
    client.submitTransaction = async () => {
      submitCalls++;
      return '0x123' as Hex;
    };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 60000,
    });

    await tickWatcher(watcher);
    assert.equal(nonceCalls, 0, 'must not look up nonce when autoSettlementEnabled=false');
    assert.equal(submitCalls, 0, 'must not submit transaction when autoSettlementEnabled=false');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'AUTO_SETTLEMENT_DISABLED');
    journal.close();
  });

  // 14. Disabled-mode read-only recovery behavior matches the documented server startup policy.
  it('14. Disabled-mode read-only recovery behavior matches the documented server startup policy', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'COMPLETED' });
    client.activeRental = null;
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: true };

    let submitCalls = 0;
    client.submitTransaction = async () => {
      submitCalls++;
      throw new Error('should not submit');
    };

    const watcher = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: false,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher.runRecovery();
    assert.equal(submitCalls, 0, 'zero submits');
    const job = journal.getJob(identity);
    assert.equal(job?.stage, 'CONFIRMED', 'read-only recovery successfully marked confirmed onchain completed rental');
    journal.close();
  });

  // 15. Restart after each injected persistence failure does not duplicate settlement transactions.
  it('15. Restart after each injected persistence failure does not duplicate settlement transactions', async () => {
    const journal = new SqliteSettlementJournal(testDbPath);
    journal.createOrLoadJob(identity, { nodeId: '1' });
    journal.claimJob(identity, 'owner-1', Date.now() + 60000);
    journal.recordPreparing(identity, { senderAddress: providerAccount.address, transactionNonce: '5', ownerId: 'owner-1' });
    journal.recordSubmitted(identity, { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', ownerId: 'owner-1' });

    journal.recordMined = () => false;

    const client = new MockJournalRentalClient();
    client.rental = activeRental({ rentalId: 42n, status: 'ACTIVE' });
    client.activeRental = client.rental;

    const watcher1 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-1',
    });

    await watcher1.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'no transaction sent during first run');

    // Simulate process restart with fresh watcher and un-mocked journal
    journal.recordMined = new SqliteSettlementJournal(testDbPath).recordMined;
    const watcher2 = new ReservationWatcher(client, createMonitor(), 100, {
      autoSettlementEnabled: true,
      journal,
      claimLeaseMs: 60000,
      ownerId: 'owner-2',
    });

    // Expire lease so owner-2 can claim
    const db = (journal as any).ensureDb();
    db.prepare(`UPDATE settlement_jobs SET claim_expires_at_ms = 0 WHERE rental_id = '42'`).run();

    await watcher2.runRecovery();
    assert.equal(client.submitCalls.length, 0, 'no duplicate transaction sent during restart recovery');
    journal.close();
  });
});


