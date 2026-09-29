/**
 * Renter authentication: challenge, signature, verify, memory-only session.
 *
 * The bearer token is held in a single variable inside `SessionStore` and
 * nowhere else. It is not written to `localStorage` or `sessionStorage`, not
 * placed in a cookie, and never logged. A page reload drops it and the renter
 * signs a fresh challenge — a deliberate trade, because a stored token is a
 * token that outlives the person who created it.
 *
 * The session is dropped, not merely hidden in the UI, when any of these
 * happens: the wallet account changes, the chain changes, the wallet
 * disconnects, or the Agent reports the session as dead (401, or 409 which is
 * the rental-change response). Those codes are handled here rather than retried
 * as ordinary failures, because retrying a dead session can only fail again.
 */

import { callAgent, isSessionDead, parseChallenge, parseSession, type Session } from './agentClient';
import type { Eip1193Provider } from './wallet';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The request shape `eth_signTypedData_v4` takes. */
interface TypedDataParams {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type AuthChallenge = ReturnType<typeof parseChallenge>;

/**
 * Holds the current session token and nothing else.
 *
 * `revoke()` is the only way the token leaves, and it runs on every revocation
 * path — so a token cannot survive an identity change by accident.
 */
export class SessionStore {
  private current: Session | null = null;

  get token(): string | null {
    return this.current?.token ?? null;
  }

  get session(): Session | null {
    return this.current;
  }

  set(session: Session): void {
    this.current = session;
  }

  revoke(): void {
    this.current = null;
  }

  /** True when the token is past the expiry the Agent gave it. */
  isExpired(nowMs: number = Date.now()): boolean {
    if (!this.current) return true;
    return Math.floor(nowMs / 1000) >= this.current.expiresAt;
  }

  /** True when the stored session belongs to this rental. */
  matchesRental(rentalId: bigint): boolean {
    return this.current !== null && this.current.rentalId === rentalId;
  }
}

/** Signs the Agent's typed-data payload with the renter's own account. */
export async function signChallenge(
  wallet: Eip1193Provider,
  account: string,
  challenge: AuthChallenge,
): Promise<string> {
  const typed: TypedDataParams = {
    domain: challenge.domain,
    types: challenge.types,
    primaryType: challenge.primaryType,
    message: challenge.message,
  };
  try {
    const signature = await wallet.request({
      method: 'eth_signTypedData_v4',
      params: [account, JSON.stringify(typed)],
    });
    if (typeof signature !== 'string' || signature.length < 10) {
      throw new AuthError('Wallet returned an unusable signature.');
    }
    return signature;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 4001) throw new AuthError('You rejected the sign request in your wallet.');
    throw new AuthError(error instanceof Error ? error.message : String(error));
  }
}

/** Asks the Agent for a challenge bound to one rental. */
export async function requestChallenge(
  origin: string,
  rentalId: bigint,
  signal?: AbortSignal,
): Promise<AuthChallenge> {
  const raw = await callAgent(origin, '/auth/challenge', {
    method: 'POST',
    body: { rentalId: rentalId.toString() },
    signal,
  });
  return parseChallenge(raw);
}

/** Exchanges a signed challenge for a memory-only session token. */
export async function verifyChallenge(
  origin: string,
  rentalId: bigint,
  signature: string,
  nonce?: string,
  signal?: AbortSignal,
): Promise<Session> {
  const body: Record<string, string> = {
    rentalId: rentalId.toString(),
    signature,
  };
  if (nonce) {
    body.nonce = nonce;
  }
  const raw = await callAgent(origin, '/auth/verify', {
    method: 'POST',
    body,
    signal,
  });
  return parseSession(raw);
}

/**
 * The full login round trip, in the one order the Agent accepts.
 *
 * Each step's failure is reported on its own, because "challenge failed" and
 * "verify failed" need different actions from the renter: the first usually
 * means the rental is not ACTIVE yet, the second that the signature came from a
 * different account or a stale nonce.
 */
export async function authenticate(
  origin: string,
  wallet: Eip1193Provider,
  account: string,
  rentalId: bigint,
  signal?: AbortSignal,
): Promise<Session> {
  const challenge = await requestChallenge(origin, rentalId, signal);
  const signature = await signChallenge(wallet, account, challenge);
  const nonce = typeof challenge.message.nonce === 'string' ? challenge.message.nonce : undefined;
  return verifyChallenge(origin, rentalId, signature, nonce, signal);
}

export { isSessionDead };
