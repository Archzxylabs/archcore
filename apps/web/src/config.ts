/**
 * Renter-side chain configuration.
 *
 * Contract addresses arrive from the Agent's public `GET /config` response.
 * The ABI is loaded and validated by `@archcore/chain`; Web consumes the
 * resulting client ABI and normalized methods rather than requesting ABI data
 * from the Agent or maintaining its own positional decoder.
 *
 * Every field is validated before use. A missing address, a mismatched
 * chainId, or an ABI without the P0 methods is a hard error naming what is
 * wrong — never a silently degraded flow that looks healthy.
 *
 * The `/config` body carries no economics: since v0.5 the price, the duration
 * and the plan catalog are contract state, read from the manager's
 * `planCount`/`getPlan` rather than repeated here as a second copy that could
 * disagree with the chain.
 */

/** Chain ID frozen by the interface ledger. */
export const CHAIN_ID = 46630;

/** Chain ID as the `eth_chainId` hex string the wallet JSON-RPC returns. */
export const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;

/** Native currency used by the wallet's add/switch chain RPC. */
export const CHAIN_NATIVE_CURRENCY = {
  name: 'Ether',
  symbol: 'ETH',
  decimals: 18,
} as const;

/** Human-readable network name shown in the wallet prompt and the UI. */
export const CHAIN_NAME = 'Robinhood Chain Testnet';

/**
 * Callable methods the renter needs, as the shipped artifact names them.
 *
 * `getRental`, `getNode` and `getListing` are read through the same public RPC
 * the wallet uses; `rent`, `cancelExpiredReservation` and `settleAfterExpiry`
 * are sent as transactions from the renter's own wallet. `startRental` is the
 * provider's call and is never built here — it is listed so a config that
 * exposes only part of the surface can be detected instead of half-used.
 *
 * Per INTERFACE_CONTRACTS.md §2 and §4, the canonical on-chain production selector
 * is `activeRentalForNode(uint256) -> (bool, uint256)`. Neither `nodeIsRented`
 * nor `getActiveRentalForNode` are on-chain selectors. Any TypeScript ergonomic
 * helper named `nodeIsRented` or `getActiveRentalForNode` delegates strictly to
 * `activeRentalForNode`.
 */
import { DEFAULT_EXPLORER_URL, DEFAULT_RPC_URL, USDG_ADDRESS } from './chainPure';

export const REQUIRED_ABI_METHODS = [
  'paymentToken',
  'planCount',
  'getPlan',
  'getNode',
  'getListing',
  'getRental',
  'activeRentalForNode',
  'rent',
  'startRental',
  'cancelExpiredReservation',
  'settleAfterExpiry',
] as const;

/** A function entry of a JSON ABI, as produced by `cargo stylus export-abi`. */
export interface AbiFunctionEntry {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: ReadonlyArray<{ type: string; name?: string }>;
  outputs?: ReadonlyArray<unknown>;
  [key: string]: unknown;
}

/** Shape returned by `GET /config` as the renter needs it. */
export interface AgentConfig {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  rentalManagerAddress: string;
  computeAssetAddress?: string;
  paymentToken?: string;
  paymentSymbol?: string;
  agentAudience?: string;
  inferenceMode?: string;
  interfaceVersion?: string;
  nodeId: bigint;
  /** Decimal places the rental price is quoted in; read from the token itself. */
  paymentDecimals?: number;
}

/** A JSON-RPC call that failed, with the method that failed. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function asString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ConfigError(`${field} is missing from GET /config`);
  }
  return raw.trim();
}

function asBigInt(raw: unknown, field: string): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  throw new ConfigError(`${field} is not a decimal integer: ${String(raw)}`);
}

function asInteger(raw: unknown, field: string): number {
  const value = asBigInt(raw, field);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigError(`${field} is too large to use as a number: ${String(raw)}`);
  }
  return Number(value);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
declare const ARCHCORE_WEB_RPC_URL: string | undefined;
declare const ARCHCORE_WEB_EXPLORER_URL: string | undefined;

/**
 * Validates the Agent's `/config` body into the fields the renter acts on.
 *
 * A wrong chainId is refused here rather than at send time: a wallet on the
 * wrong network cannot produce a valid signed transaction, and catching it
 * before the wallet prompt is the difference between one clear message and a
 * confusing rejection.
 */
export function parseAgentConfig(raw: unknown): AgentConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('GET /config did not return a JSON object');
  }
  const body = raw as Record<string, unknown>;

  const chainId = asInteger(body.chainId, 'chainId');
  if (chainId !== CHAIN_ID) {
    throw new ConfigError(`Agent is on chain ${chainId}, this renter only supports ${CHAIN_ID}.`);
  }

  const rawManager = body.rentalManagerAddress ?? body.rentalManager;
  const rentalManagerAddress = asString(rawManager, 'rentalManager');
  if (!ADDRESS_RE.test(rentalManagerAddress)) {
    throw new ConfigError(`rentalManagerAddress is not an address: ${rentalManagerAddress}`);
  }

  const rawRpc = typeof ARCHCORE_WEB_RPC_URL === 'string'
    ? ARCHCORE_WEB_RPC_URL
    : DEFAULT_RPC_URL;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawRpc);
  } catch {
    throw new ConfigError(`rpcUrl is not a URL: ${rawRpc}`);
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new ConfigError(`rpcUrl must use http(s): ${rawRpc}`);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.pathname !== '/') {
    throw new ConfigError('Browser RPC must be credential-free. Keep operator RPC credentials in the Agent.');
  }

  const rawExplorer = typeof ARCHCORE_WEB_EXPLORER_URL === 'string'
    ? ARCHCORE_WEB_EXPLORER_URL
    : DEFAULT_EXPLORER_URL;

  const computeAssetAddress = body.computeAssetAddress ?? body.computeAsset;
  if (computeAssetAddress !== undefined && computeAssetAddress !== null) {
    if (typeof computeAssetAddress !== 'string' || !ADDRESS_RE.test(computeAssetAddress)) {
      throw new ConfigError(`computeAssetAddress is not an address: ${String(computeAssetAddress)}`);
    }
  }

  const paymentToken = body.paymentToken !== undefined && body.paymentToken !== null
    ? asString(body.paymentToken, 'paymentToken')
    : USDG_ADDRESS;
  if (!ADDRESS_RE.test(paymentToken)) {
    throw new ConfigError(`paymentToken is not an address: ${paymentToken}`);
  }
  if (paymentToken.toLowerCase() !== USDG_ADDRESS.toLowerCase()) throw new ConfigError('Payment token must be the frozen USDG address.');
  if (asBigInt(body.nodeId ?? '1', 'nodeId') !== 1n) throw new ConfigError('ARCHcore P0 supports Node 1 only.');
  if (body.inferenceMode !== undefined && body.inferenceMode !== 'demo') throw new ConfigError('P0 requires explicit demo inference mode.');
  if (body.interfaceVersion !== undefined && body.interfaceVersion !== '0.5') throw new ConfigError('Agent interface version must be 0.5.');

  return {
    chainId,
    rpcUrl: rawRpc,
    explorerUrl: rawExplorer,
    rentalManagerAddress,
    computeAssetAddress: typeof computeAssetAddress === 'string' ? computeAssetAddress : undefined,
    paymentToken,
    paymentSymbol: typeof body.paymentSymbol === 'string' ? body.paymentSymbol : 'USDG',
    agentAudience: typeof body.agentAudience === 'string' ? body.agentAudience : undefined,
    inferenceMode: typeof body.inferenceMode === 'string' ? body.inferenceMode : 'demo',
    interfaceVersion: typeof body.interfaceVersion === 'string' ? body.interfaceVersion : '0.5',
    nodeId: asBigInt(body.nodeId ?? 1n, 'nodeId'),
    // The price, the duration and the start grace are all contract state now,
    // not Agent config: the renter reads them from the manager's plan catalog
    // rather than trusting a figure that could be stale by the next block.
    paymentDecimals: body.paymentDecimals !== undefined
      ? asInteger(body.paymentDecimals, 'paymentDecimals')
      : undefined,
  };
}

/** Validation error raised when an ABI cannot serve the P0 rental flow. */
export class AbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbiError';
  }
}

/**
 * Unwraps the three accepted artifact shapes and checks the method set.
 *
 * Accepted shapes (documented in `packages/abi/README.md`): the raw array, or a
 * wrapper object carrying `abi`. Anything else is refused rather than searched
 * for a hopeful path, because an unrecognised object is a sign the rename or
 * the source of the artifact was never agreed.
 */
export function normaliseAbi(raw: unknown): readonly AbiFunctionEntry[] {
  const entries: unknown = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as { abi?: unknown }).abi
    : raw;

  if (!Array.isArray(entries)) {
    throw new AbiError(
      'ABI is neither an array nor an object with an "abi" array. See packages/abi/README.md.',
    );
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      throw new AbiError('ABI contains an entry that is not an object.');
    }
    const typed = entry as AbiFunctionEntry;
    if (typed.type !== 'function') continue;
    if (typeof typed.name === 'string') names.add(typed.name);
  }

  const missing = REQUIRED_ABI_METHODS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new AbiError(
      `ABI is missing the rental methods: ${missing.join(', ')}. ` +
      `The renter must send real transactions, so an incomplete artifact is refused.`,
    );
  }

  return entries as readonly AbiFunctionEntry[];
}
