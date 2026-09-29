/**
 * Browser-side view of `@archcore/chain`.
 *
 * Browser-safe shared chain values and normalized types re-exported from the
 * packages that own them. ABI-backed reads, tuple decoding, and transaction
 * calldata encoding are handled by `@archcore/chain`; Web must not implement a
 * parallel positional decoder or selector table here.
 */

export { StatusMapper, EMPTY_ADDRESS } from '@archcore/chain';
export type {
  Address,
  ChainListing,
  ChainNode,
  ChainPlan,
  ChainRental,
  PaymentTokenMetadata,
  RentalStatus,
} from '@archcore/shared';

/**
 * Chain defaults, re-exported so the renter never restates a frozen value.
 *
 * These live in `@archcore/shared` because the Agent already reads them; a second
 * copy inside `apps/web` would let the renter and the operator disagree about
 * which chain or which node they are talking about.
 */
export {
  CHAIN_ID,
  DEFAULT_EXPLORER_URL,
  DEFAULT_RPC_URL,
  DEMO_NODE_ID,
  formatAtomic,
  FROZEN_PLANS,
  USDG_ADDRESS,
  USDG_DECIMALS_EXPECTED,
  USDG_SYMBOL,
} from '@archcore/shared';
