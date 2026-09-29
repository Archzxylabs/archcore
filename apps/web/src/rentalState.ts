/**
 * Rental state and the UI decisions derived from it.
 *
 * The renter's five screens are each a function of one rental read: which buttons
 * exist, and which of them can actually work. Deriving that here — rather than
 * scattering the same `if` through the page — means the button that is offered is
 * the button the contract will accept, and the two can never disagree.
 *
 * Deadlines are compared against `Date.now()`, never against when the page was
 * loaded: a reservation that expires while the tab sits idle must show as
 * expired, not as startable until someone reloads.
 */

import { EMPTY_ADDRESS, StatusMapper } from './chainPure';
import type { ChainRental, RentalStatus } from './chainPure';

/** An empty rental, used when the node has no live reservation. */
export function emptyRental(): ChainRental {
  return {
    rentalId: 0n,
    nodeId: 0n,
    planId: 0,
    renter: EMPTY_ADDRESS,
    provider: EMPTY_ADDRESS,
    priceAtomic: 0n,
    durationSeconds: 0n,
    price: 0n,
    status: 'NONE',
    startDeadline: 0n,
    startsAt: 0n,
    expiresAt: 0n,
    createdAt: 0n,
    raw: {},
  };
}

/** True when the retrieved rental is the empty placeholder. */
export function isNone(rental: ChainRental): boolean {
  return rental.status === 'NONE' && rental.rentalId === 0n;
}

/**
 * True when the contract has already finished this rental.
 *
 * `COMPLETED` and `CANCELLED` are the two states that release the node, and the
 * contract's own `activeRentalForNode` reports no rental for either. So a link
 * naming one describes history rather than a rental in play, and the node's
 * live slot is the only honest thing to show.
 */
export function isTerminal(rental: ChainRental): boolean {
  return rental.status === 'COMPLETED' || rental.status === 'CANCELLED';
}

/**
 * A rental currently belonging to this renter and not yet finished.
 *
 * `NONE` is excluded because a node with no rental is not the renter's. A rental
 * owned by someone else is the renter's only to observe — the UI says so instead
 * of offering buttons that would revert.
 */
export function isOwned(rental: ChainRental, account: string): boolean {
  return !isNone(rental) && rental.renter.toLowerCase() === account.toLowerCase();
}

/** True when the rental is RESERVED and inside its start grace window. */
export function canBeStarted(rental: ChainRental, nowMs: number): boolean {
  return (
    rental.status === 'RESERVED'
    && rental.startDeadline > 0n
    && BigInt(Math.floor(nowMs / 1000)) < rental.startDeadline
  );
}

/** True when a RESERVED rental missed its start deadline and may be cancelled. */
export function canCancelExpired(rental: ChainRental, nowMs: number): boolean {
  return rental.status === 'RESERVED' && !canBeStarted(rental, nowMs) && rental.startDeadline > 0n;
}

/** True when an ACTIVE rental passed its expiry and may be settled. */
export function canSettleExpired(rental: ChainRental, nowMs: number): boolean {
  return (
    rental.status === 'ACTIVE'
    && rental.expiresAt > 0n
    && BigInt(Math.floor(nowMs / 1000)) >= rental.expiresAt
  );
}

/** True while an ACTIVE rental is still inside its access window. */
export function isAccessible(rental: ChainRental, nowMs: number): boolean {
  return (
    rental.status === 'ACTIVE'
    && rental.startsAt > 0n
    && BigInt(Math.floor(nowMs / 1000)) >= rental.startsAt
    && rental.expiresAt > rental.startsAt
    && BigInt(Math.floor(nowMs / 1000)) < rental.expiresAt
  );
}

/**
 * The one state the UI must not confuse with any other.
 *
 * A RESERVED rental the provider has not started looks like an ACTIVE one at a
 * glance (both exist, both block the node), but only the ACTIVE one is billable
 * and only the RESERVED one can still be started. The Agent refuses a challenge
 * against a RESERVED rental, so showing these as distinct states is what keeps
 * the UI's accounting promise honest.
 */
export type LifecycleStage =
  | 'none'
  | 'available'
  | 'reserved'
  | 'starting'
  | 'active'
  | 'expired'
  | 'settled'
  | 'cancelled'
  | 'foreign';

export function lifecycleStage(
  rental: ChainRental,
  account: string,
  nowMs: number,
): LifecycleStage {
  if (isNone(rental)) return 'none';
  if (!isOwned(rental, account)) return 'foreign';
  switch (rental.status) {
    case 'RESERVED':
      return canBeStarted(rental, nowMs) ? 'reserved' : 'expired';
    case 'ACTIVE':
      return isAccessible(rental, nowMs) ? 'active' : 'expired';
    case 'COMPLETED':
      return 'settled';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'none';
  }
}

/** Formats a unix-second deadline for display, in the viewer's own zone. */
export function formatDeadline(seconds: bigint): string {
  if (seconds === 0n) return '—';
  const date = new Date(Number(seconds) * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Seconds remaining until `seconds`, never below zero. */
export function secondsRemaining(seconds: bigint, nowMs: number): number {
  if (seconds === 0n) return 0;
  const remaining = Number(seconds) - Math.floor(nowMs / 1000);
  return remaining > 0 ? remaining : 0;
}

export { EMPTY_ADDRESS, StatusMapper };
export type { ChainRental, RentalStatus };
