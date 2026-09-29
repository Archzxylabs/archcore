import { randomBytes, createHash } from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import type { ChainRental } from '@archcore/shared';

/**
 * EIP-712 single-use challenge.
 *
 * The domain binds a signature to this node, this chain, this RentalManager
 * contract and this audience, so a signature produced for another site, another
 * node or another deployment cannot be replayed here. The renter signs the
 * message on the client; we recover the signer locally.
 */
export const CHALLENGE_TYPES = {
  ComputeRWAAgentAuth: [
    { name: 'renter', type: 'address' },
    { name: 'rentalId', type: 'uint256' },
    { name: 'nodeId', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'agentAudience', type: 'string' },
  ],
} as const;

export const CHALLENGE_DOMAIN_NAME = 'ComputeRWA Agent Auth';
export const CHALLENGE_DOMAIN_VERSION = '1';

/**
 * The domain field list exactly as viem's `getTypesForEIP712Domain` derives it
 * from a `{ name, version, chainId, verifyingContract }` domain.
 *
 * `eth_signTypedData_v4` receives this object verbatim, so the types map must
 * already contain `EIP712Domain` - a wallet derives the domain separator from
 * the types map, not from the sibling `domain` field. The field set must match
 * the domain exactly: naming `verifyingContract` without a value in `domain`
 * makes viem throw `InvalidAddressError: Address "undefined" is invalid`, and
 * omitting a field that the domain carries changes the separator hash and
 * breaks recovery. See test/auth.test.ts, which hashes the browser-shaped and
 * the server-shaped payloads and asserts they are equal.
 *
 * Order matters: EIP-712 hashes the domain fields in the order the types map
 * declares them, and every major wallet emits
 * name, version, chainId, verifyingContract.
 */
export const EIP712_DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

/**
 * The types map handed to `eth_signTypedData_v4`: domain fields plus the
 * challenge struct. `CHALLENGE_TYPES` above is the same struct without the
 * domain entry, which is what we pass to viem (viem injects the domain itself).
 */
export const SIGN_TYPES = {
  EIP712Domain: EIP712_DOMAIN_TYPES,
  ...CHALLENGE_TYPES,
} as const;

/**
 * EIP-712 domain, restricted to the fields viem/ethers both hash identically.
 *
 * `verifyingContract` is the RentalManager the rental lives on: it pins the
 * signature to this deployment, so a challenge minted against a manager on
 * another chain cannot be replayed even by the same renter wallet.
 */
export interface ChallengeDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface Challenge {
  nonce: string;
  rentalId: string;
  renter: string;
  nodeId: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
}

/** The public shape returned to the browser - never the internal flags. */
export interface IssuedChallenge {
  nonce: string;
  rentalId: string;
  renter: string;
  nodeId: string;
  audience: string;
  chainId: number;
  domain: ChallengeDomain;
  types: typeof CHALLENGE_TYPES;
  primaryType: 'ComputeRWAAgentAuth';
  message: {
    renter: string;
    rentalId: string;
    nodeId: string;
    nonce: string;
    // Decimal strings, never JSON numbers: see `server.ts` typed-data response.
    issuedAt: string;
    expiresAt: string;
    agentAudience: string;
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function buildDomain(chainId: number, verifyingContract: `0x${string}`): ChallengeDomain {
  return {
    name: CHALLENGE_DOMAIN_NAME,
    version: CHALLENGE_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

/** Random 32-byte nonce as 0x-prefixed hex. */
export function randomNonce(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

export class ChallengeStore {
  private readonly challenges = new Map<string, Challenge>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly ttlSeconds: number) {
    // Periodic sweep so expired challenges never accumulate in memory.
    this.timer = setInterval(() => this.sweep(), Math.max(1000, ttlSeconds * 500));
    this.timer.unref?.();
  }

  issue(params: {
    rentalId: string;
    renter: string;
    nodeId: string;
    audience: string;
    now: number;
    expiresAt?: number;
  }): Challenge {
    const challenge: Challenge = {
      nonce: randomNonce(),
      rentalId: params.rentalId,
      renter: params.renter.toLowerCase(),
      nodeId: params.nodeId,
      audience: params.audience,
      issuedAt: params.now,
      expiresAt: params.expiresAt ?? params.now + this.ttlSeconds,
      consumed: false,
    };
    this.challenges.set(this.key(challenge.nonce, challenge.rentalId), challenge);
    return challenge;
  }

  /**
   * Non-mutating lookup. Validates that the nonce exists, is still inside its
   * TTL, and that the audience the server is configured with still matches the
   * one the challenge was minted with, but does NOT mark it consumed - a
   * rejected signature must never burn a still-valid challenge. Throws
   * CHALLENGE_REPLAYED for an unknown or already-used nonce and
   * CHALLENGE_EXPIRED once the TTL has lapsed.
   */
  lookup(nonce: string, rentalId: string, now: number, audience?: string): Challenge {
    const challenge = this.challenges.get(this.key(nonce, rentalId));
    if (!challenge) throw new AuthError('unknown challenge nonce', 'CHALLENGE_NOT_FOUND');
    if (challenge.consumed) throw new AuthError('challenge already used', 'CHALLENGE_REPLAYED');
    if (challenge.expiresAt <= now) throw new AuthError('challenge expired', 'CHALLENGE_EXPIRED');
    if (audience !== undefined && challenge.audience !== audience) {
      throw new AuthError('challenge audience does not match this agent', 'AUDIENCE_MISMATCH');
    }
    return challenge;
  }

  /**
   * Compare-and-consume, called only AFTER the signature has been recovered and
   * matched - `lookup` gets the caller that far without mutating anything, so a
   * rejected signature never burns a valid challenge.
   *
   * Returns `true` for exactly the first caller that presents a known, unconsumed,
   * unexpired, audience-matching challenge, and `false` for every later or
   * invalid attempt. It deliberately does not throw: the caller has already
   * checked the signature, so a `false` here means one thing only - someone else
   * won the race, or the challenge lapsed between `lookup` and here. Either way
   * the caller must not mint a session.
   *
   * Atomicity comes from being synchronous: the whole check-and-flip runs to
   * completion inside one event-loop turn, so two parallel verifies cannot both
   * observe `consumed === false`.
   */
  consume(nonce: string, rentalId: string, now: number, audience?: string): boolean {
    const challenge = this.challenges.get(this.key(nonce, rentalId));
    if (!challenge) return false;
    if (challenge.consumed) return false;
    if (challenge.expiresAt <= now) return false;
    if (audience !== undefined && challenge.audience !== audience) return false;
    challenge.consumed = true;
    return true;
  }

  activeCount(): number {
    return this.challenges.size;
  }

  private key(nonce: string, rentalId: string): string {
    return `${createHash('sha256').update(nonce.toLowerCase()).digest('hex')}:${rentalId}`;
  }

  private sweep(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, challenge] of this.challenges) {
      if (challenge.consumed || challenge.expiresAt <= now) this.challenges.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/** Builds the exact EIP-712 payload the browser must sign. */
export function typedDataPayload(domain: ChallengeDomain, challenge: Challenge) {
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: CHALLENGE_TYPES,
    primaryType: 'ComputeRWAAgentAuth' as const,
    message: {
      renter: challenge.renter as `0x${string}`,
      rentalId: BigInt(challenge.rentalId),
      nodeId: BigInt(challenge.nodeId),
      nonce: challenge.nonce as `0x${string}`,
      issuedAt: BigInt(challenge.issuedAt),
      expiresAt: BigInt(challenge.expiresAt),
      agentAudience: challenge.audience,
    },
  };
}

/**
 * Recovers the signer and enforces that it is the on-chain renter of the
 * rental the challenge was issued for, signed for this node and this agent
 * audience. Does not touch challenge state - the caller consumes the nonce only
 * after this resolves.
 */
export async function verifyChallenge(params: {
  challenge: Challenge;
  signature: string;
  domain: ChallengeDomain;
  rental: ChainRental;
  now: number;
  /** When given, the audience inside the signed message must equal it. */
  audience?: string;
}): Promise<string> {
  const { challenge, signature, domain, rental, now } = params;

  if (challenge.expiresAt <= now) {
    throw new AuthError('challenge expired', 'CHALLENGE_EXPIRED');
  }

  if (params.audience !== undefined && challenge.audience !== params.audience) {
    throw new AuthError('challenge audience does not match this agent', 'AUDIENCE_MISMATCH');
  }

  let recovered: string;
  try {
    const payload = typedDataPayload(domain, challenge);
    recovered = await recoverTypedDataAddress({
      ...payload,
      signature: signature as `0x${string}`,
    });
  } catch {
    throw new AuthError('signature could not be recovered', 'INVALID_SIGNATURE');
  }

  if (recovered.toLowerCase() !== challenge.renter.toLowerCase()) {
    throw new AuthError('recovered signer does not match challenge renter', 'INVALID_SIGNATURE');
  }

  const onChainRenter = rental.renter.toLowerCase();
  if (recovered.toLowerCase() !== onChainRenter) {
    throw new AuthError('recovered signer is not the on-chain renter', 'INVALID_SIGNATURE');
  }

  if (challenge.nodeId !== String(rental.nodeId)) {
    throw new AuthError('challenge was issued for a different node', 'INVALID_SIGNATURE');
  }

  return recovered;
}
