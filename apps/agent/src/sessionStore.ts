import { createHash, randomBytes } from 'node:crypto';
import { ArchcoreError, ErrorCode } from '@archcore/shared';

/**
 * A session is created only after a valid signature over an ACTIVE rental.
 * The server keeps only the SHA-256 digest of the token as the map key; the raw
 * token is returned exactly once in the HTTPS response and lives only in the
 * browser's memory and the Authorization header. Nothing here is ever keyed by
 * rentalId, and no record - stored or returned - ever carries the raw token:
 * there is no `id` field to echo back, so a stolen map, a log line or a debug
 * dump cannot hand out a usable credential.
 */
export interface StoredSession {
  /** SHA-256 hex digest of the raw bearer token. The only token-derived value kept. */
  readonly digest: string;
  rentalId: string;
  nodeId: string;
  renter: string;
  expiresAt: number;
}

/**
 * What the server resolves a bearer token to. Identical to the stored record,
 * because the record itself is already safe to hand around: it has no token.
 */
export type Session = StoredSession;

/** Minted session: the raw token exactly once, plus the safe server-side record. */
export interface CreatedSession {
  /** The raw bearer token. Returned to the caller once and never stored or logged. */
  token: string;
  session: Session;
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /**
   * Mints a fresh session. The raw token (32 bytes, base64url) is handed back in
   * `token` and only there; the map keeps just its digest.
   */
  create(params: { rentalId: string; nodeId: string; renter: string; expiresAt: number }): CreatedSession {
    const token = randomBytes(32).toString('base64url');
    const record: StoredSession = {
      digest: digestOf(token),
      rentalId: params.rentalId,
      nodeId: params.nodeId,
      renter: params.renter.toLowerCase(),
      expiresAt: params.expiresAt,
    };
    this.sessions.set(record.digest, record);
    return { token, session: record };
  }

  /** Resolves a raw bearer token to its session, or throws INVALID_SESSION / SESSION_EXPIRED. */
  get(token: string, now: number): Session {
    const record = this.sessions.get(digestOf(token));
    if (!record) throw new ArchcoreError(ErrorCode.INVALID_SESSION, 'unknown session', 401);
    if (record.expiresAt <= now) {
      throw new ArchcoreError(ErrorCode.SESSION_EXPIRED, 'lease has ended', 401);
    }
    return record;
  }

  /** Drops a session by its raw token, e.g. when the rental ends. */
  remove(token: string): void {
    this.sessions.delete(digestOf(token));
  }

  /**
   * Read-only view of the record behind a raw token. Exists so tests can prove
   * the stored record carries a digest and no raw token; never returns a token.
   */
  recordFor(token: string): Readonly<StoredSession> | undefined {
    return this.sessions.get(digestOf(token));
  }

  activeCount(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [digest, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(digest);
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/**
 * Sessions are keyed by token digest, so a stolen map never yields a usable token.
 * Exported so the store and its tests derive the key the same way.
 */
export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
