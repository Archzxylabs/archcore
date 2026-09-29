import { isAddress } from 'viem';
import { ArchcoreError, ErrorCode, type ChainRental } from '@archcore/shared';
import type { RentalManagerClient } from '@archcore/chain';

/**
 * Reads the authoritative rental from the chain and re-applies every P0 access
 * condition. This is the single gate used by challenge issuance, verification
 * and every inference request — the agent never trusts a value the client sent.
 *
 * An RPC failure is a denial: the caller gets `RPC_UNAVAILABLE` (503) rather
 * than a permissive fallback, so a broken node cannot be talked into serving a
 * rental that no longer exists.
 */
export async function loadAuthoritativeRental(
  client: RentalManagerClient,
  rentalId: bigint,
  nodeId: bigint,
): Promise<ChainRental> {
  let rental: ChainRental | null = null;
  try {
    rental = await client.getRental(rentalId);
  } catch (error) {
    throw new ArchcoreError(ErrorCode.RPC_UNAVAILABLE, 'rental manager read failed', 503, {
      cause: error,
    });
  }
  if (!rental) {
    throw new ArchcoreError(ErrorCode.RENTAL_NOT_FOUND, 'rental not found on chain', 404);
  }
  if (rental.rentalId !== rentalId) {
    throw new ArchcoreError(ErrorCode.RENTAL_NOT_ACTIVE, 'rental ID mismatch');
  }
  assertRentalIsActiveForNode(rental, nodeId, Math.floor(Date.now() / 1000));
  return rental;
}

/**
 * Rejects anything that is not a live, valid-EOA rental of THIS node:
 * another node's rental, a RESERVED/CANCELLED/COMPLETED lease, and an expired
 * one. `renter` additionally pins the on-chain renter, so a rental that changed
 * hands cannot be driven by the previous renter's session.
 */
export function assertRentalIsActiveForNode(
  rental: ChainRental,
  nodeId: bigint,
  now: number,
  renter?: string,
): void {
  if (rental.nodeId !== nodeId) {
    throw new ArchcoreError(
      ErrorCode.RENTAL_NOT_ACTIVE,
      'rental belongs to a different node',
      409,
    );
  }
  if (rental.status !== 'ACTIVE') {
    throw new ArchcoreError(
      ErrorCode.RENTAL_NOT_ACTIVE,
      `rental is ${rental.status}, not ACTIVE`,
      409,
    );
  }
  if (Number(rental.expiresAt) === 0 || now >= Number(rental.expiresAt)) {
    throw new ArchcoreError(ErrorCode.RENTAL_EXPIRED, 'rental has expired', 409);
  }
  if (renter !== undefined && !isAddress(renter)) {
    throw new ArchcoreError(ErrorCode.INVALID_SIGNATURE, 'renter is not a valid EOA', 401);
  }
  if (renter !== undefined && renter.toLowerCase() !== rental.renter.toLowerCase()) {
    throw new ArchcoreError(
      ErrorCode.RENTAL_NOT_ACTIVE,
      'signer is not the on-chain renter of this rental',
      409,
    );
  }
}

/**
 * A challenge may only be minted for a rental that is ACTIVE on this node and
 * still inside its lease, and whose renter is a plain EOA (a contract renter
 * cannot produce an `eth_signTypedData_v4` signature the server can recover).
 */
export async function assertChallengeIsAllowed(
  client: RentalManagerClient,
  rentalId: bigint,
  nodeId: bigint,
): Promise<ChainRental> {
  const rental = await loadAuthoritativeRental(client, rentalId, nodeId);
  if (!isAddress(rental.renter)) {
    throw new ArchcoreError(
      ErrorCode.INVALID_SIGNATURE,
      'renter is not a valid EOA',
      401,
    );
  }
  return rental;
}
