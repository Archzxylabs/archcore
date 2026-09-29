import type { Address, ChainPlan, RentalStatus } from './chain';

/**
 * Authoritative rental state read from `RentalManager` via `eth_call`.
 *
 * Exactly matches the 12-tuple emitted by `getRental(uint256)`:
 * (rentalId, nodeId, planId, renter, provider, priceAtomic, durationSeconds,
 *  status, startDeadline, startsAt, expiresAt, createdAt)
 */
export interface ChainRental {
  rentalId: bigint;
  nodeId: bigint;
  planId: number;
  renter: Address;
  provider: Address;
  /** Escrowed amount in atomic token units (USDG). */
  priceAtomic: bigint;
  /** Planned active duration in seconds. */
  durationSeconds: bigint;
  status: RentalStatus;
  /** Unix seconds. After this, `startRental()` is no longer possible. */
  startDeadline: bigint;
  /** Unix seconds the rental became ACTIVE (0 while not started). */
  startsAt: bigint;
  /** Unix seconds access ends (0 while not started). */
  expiresAt: bigint;
  /** Unix seconds the reservation was created. */
  createdAt: bigint;
  /** Backward-compatible alias for priceAtomic. */
  price?: bigint;
  /** Decoded getter output, kept for diagnostics only — never logged raw. */
  raw?: Record<string, unknown>;
}

export interface ChainNode {
  nodeId: bigint;
  provider: Address;
  name: string;
  active: boolean;
  raw?: Record<string, unknown>;
}

export interface ChainListing {
  nodeId: bigint;
  paymentToken: Address;
  active: boolean;
  /** Backward-compatible optional field for legacy consumers. */
  priceWei?: bigint;
  raw?: Record<string, unknown>;
}

export type { ChainPlan } from './chain';

export type ActiveRentalResult = ChainRental | null;

export interface PaymentTokenMetadata {
  address: Address;
  symbol: string;
  decimals: number;
}

/** What the Agent needs from a rental-state source (chain or test double). */
export interface RentalSource {
  /** Latest on-chain rental, or null when the id does not exist. */
  getRental(rentalId: bigint): Promise<ChainRental | null>;
  /** Non-terminal (RESERVED or ACTIVE) rental for the node, or null. */
  getActiveRentalForNode(nodeId: bigint): Promise<ChainRental | null>;
  getNode(nodeId: bigint): Promise<ChainNode>;
  getListing(nodeId: bigint): Promise<ChainListing>;
  getPlan?(planId: number): Promise<ChainPlan>;
  planCount?(): Promise<number>;
  paymentToken?(): Promise<Address>;
}

export interface AuthChallenge {
  rentalId: string;
  renter: string;
  nodeId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionInfo {
  rentalId: string;
  renter: string;
  nodeId: string;
  /** Unix seconds, never beyond the on-chain rental expiry. */
  expiresAt: number;
  issuedAt: number;
}
