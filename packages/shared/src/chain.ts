/**
 * P0 network + lifecycle constants shared by the renter frontend and the
 * Provider Agent.
 *
 * Chain: Robinhood Chain Testnet (Arbitrum Stylus), chain ID 46630.
 * Payment: USDG (0x7E955252E15c84f5768B83c41a71F9eba181802F).
 */

export type Address = `0x${string}`;

export const CHAIN_ID = 46630;

export const DEFAULT_RPC_URL = 'https://rpc.testnet.chain.robinhood.com';

export const DEFAULT_EXPLORER_URL = 'https://explorer.testnet.chain.robinhood.com';

/** Frozen payment token: USDG on Robinhood Testnet. */
export const USDG_ADDRESS: Address = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
export const USDG_SYMBOL = 'USDG';
export const USDG_DECIMALS_EXPECTED = 6;

/** Exactly two minutes from a successful `rent()` for the agent to start. */
export const START_GRACE_SECONDS = 120;

/** Default enum order declared in the PRD and contract source. */
export const DEFAULT_RENTAL_STATUS_ORDER = [
  'NONE',
  'RESERVED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;

export type RentalStatus = (typeof DEFAULT_RENTAL_STATUS_ORDER)[number];

export const DEMO_NODE_ID = 1n;

export type { RentalStatus as RentalStatusCode };

export interface ChainPlan {
  planId: number;
  durationSeconds: bigint;
  priceAtomic: bigint;
  active: boolean;
  demoOnly: boolean;
}

/**
 * Immutable 7-plan catalog from PRD §6.3 and ledger §1.
 */
export const FROZEN_PLANS: readonly ChainPlan[] = [
  { planId: 0, durationSeconds: 300n, priceAtomic: 100000n, active: true, demoOnly: true },
  { planId: 1, durationSeconds: 21600n, priceAtomic: 6000000n, active: true, demoOnly: false },
  { planId: 2, durationSeconds: 43200n, priceAtomic: 11400000n, active: true, demoOnly: false },
  { planId: 3, durationSeconds: 86400n, priceAtomic: 21600000n, active: true, demoOnly: false },
  { planId: 4, durationSeconds: 604800n, priceAtomic: 142800000n, active: true, demoOnly: false },
  { planId: 5, durationSeconds: 1209600n, priceAtomic: 268800000n, active: true, demoOnly: false },
  { planId: 6, durationSeconds: 2592000n, priceAtomic: 504000000n, active: true, demoOnly: false },
] as const;

/**
 * Formats an atomic token amount for display.
 *
 * Every amount the renter sees is atomic units on the contract side and a
 * decimal string on the UI side, and the conversion belongs in one place so the
 * renter, the Agent and the operator all render "100000 USDG atomic units" the
 * same way. Trailing fractional zeros are dropped so a whole number reads as a
 * whole number; the symbol is appended only when the caller has one.
 */
export function formatAtomic(
  amount: bigint,
  decimals: number,
  symbol = '',
): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body =
    whole === 0n && fraction === ''
      ? '0'
      : fraction
        ? `${whole}.${fraction}`
        : String(whole);
  return symbol ? `${body} ${symbol}` : body;
}
