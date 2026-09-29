import { readFileSync, existsSync, statSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isAddress } from 'viem';
import {
  CHAIN_ID,
  DEFAULT_RPC_URL,
  DEFAULT_LIMITS,
  type ResourceLimits,
} from '@archcore/shared';

export interface AgentConfig {
  host: string;
  port: number;
  logLevel: string;
  /** Origins allowed by CORS; empty = reject every browser origin. */
  allowedOrigins: string[];
  /** Canonical EIP-712 audience. Must match what the frontend signs. */
  audience: string;
  /** Chain + node config for the RentalManager client. */
  chain: import('@archcore/chain').ChainConfig;
  nodeId: bigint;
  paymentToken: `0x${string}`;
  paymentSymbol: string;
  interfaceVersion: string;
  inferenceMode: 'demo';
  /** Public browser RPC allowed by CSP, never the credentialed provider RPC. */
  browserRpcOrigin?: string;
  /** Poll interval for the reservation watcher, in ms. */
  watchIntervalMs: number;
  /** Provider wallet; required for the automatic `startRental()`. */
  providerPrivateKey?: string;
  limits: ResourceLimits;
  gpu: {
    /** GPU name reported by nvidia-smi. */
    expectedName: string;
    /** Refuse to auto-start above this temperature, in Celsius. */
    maxTemperatureC: number;
    /** Refuse to auto-start with less than this free VRAM, in MB. */
    minFreeVramMb: number;
  };
  /** Set false to disable the auto-start loop (tests / dry runs). */
  autoStartEnabled: boolean;
  /** Set false to disable the auto-settle loop (tests / dry runs). */
  autoSettlementEnabled?: boolean;
  settleRetryMaxAttempts?: number;
  settleRetryDelayMs?: number;
  settlementDbPath?: string;
  settleClaimLeaseMs?: number;
  settleBusyTimeoutMs?: number;
}

/** Matches the check types; convert to boolean with `healthy`. */
export type HealthLevel = 'ok' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthCheck {
  name: 'agent' | 'backend' | 'rpc' | 'gpu' | 'model' | 'reservation-capacity' | 'concurrency-capacity' | 'privateRoute';
  status: HealthLevel;
  detail?: string;
}

export const USDG_ADDRESS = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as const;

const REQUIRED_ENV = ['RENTAL_MANAGER_ADDRESS'] as const;

/**
 * Default location of the node operator's `.env`: the Agent's own directory,
 * then the repo root, then one directory up from that (the layout a
 * `dist/server.js` run produces). The first file that exists wins.
 */
const ENV_CANDIDATES = [
  resolve(__dirname, '..', '.env'),
  resolve(__dirname, '..', '..', '.env'),
  resolve(__dirname, '..', '..', '..', '.env'),
];

/**
 * Parses a `.env` file into records without overwriting anything already in the
 * process environment.
 *
 * `KEY=VALUE` per line, `#` comments and blank lines skipped, optional
 * `export ` prefix and matching single/double quotes stripped. The source file
 * is never rewritten.
 */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = withoutExport.slice(eq + 1).trim();
    // A trailing comment on an unquoted value is not part of the value; leave
    // quoted values alone, because `#` is legal inside quotes.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads the node operator's `.env` before any config validation runs.
 *
 * The read is deterministic: the same candidate list is walked in the same
 * order on every start, and the real environment always wins over the file, so
 * an operator can override any single key on the command line without editing
 * the file. Runtime startup calls this explicitly; importing config or server
 * modules never reads operator files.
 *
 * A missing `.env` is not an error: the environment can be fully populated
 * another way (systemd, a container, an exported shell), and the required-key
 * check below reports only what is genuinely missing. An unreadable or
 * unparsable file is surfaced rather than silently ignored, because proceeding
 * with half the node's configuration missing is exactly the failure that
 * produces an empty `AGENT_AUDIENCE`.
 */
export function loadEnvFile(
  paths: readonly string[] = ENV_CANDIDATES,
  target: NodeJS.ProcessEnv = process.env,
): void {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (target[key] === undefined || target[key] === '') {
        target[key] = value;
      }
    }
    return;
  }
}

/** Runtime-only configuration IO. Importing this module has no env side effects.
 * Shell values take precedence; neither process.env nor the operator file is mutated.
 */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  paths: readonly string[] = ENV_CANDIDATES,
): AgentConfig {
  const runtimeEnv = { ...env };
  loadEnvFile(paths, runtimeEnv);
  return loadAgentConfig(runtimeEnv);
}

/**
 * The P0 chain id, frozen to what the frontend and the RentalManager deploy
 * against. `loadAgentConfig` refuses to run on any other value: the id is part
 * of the EIP-712 domain, so a node that silently accepted a neighbouring chain
 * id would mint challenges its frontend cannot reproduce.
 */
function requireFrozenChainId(value: string | undefined): number {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return CHAIN_ID;
  if (!/^\d+$/.test(raw) || Number(raw) !== CHAIN_ID) {
    throw new Error(
      `RH_CHAIN_ID must be ${CHAIN_ID}: the P0 scope is one chain, and the chain id is ` +
        `part of the EIP-712 domain. Got: ${value}`,
    );
  }
  return CHAIN_ID;
}

/** A required `0x`-prefixed 20-byte address, or a throw naming the variable. */
function requireAddress(value: string | undefined, name: string): `0x${string}` {
  const trimmed = (value ?? '').trim();
  if (!isAddress(trimmed)) {
    throw new Error(
      `${name} must be a 20-byte hex address (0x + 40 hex chars), got: ${value}`,
    );
  }
  return trimmed as `0x${string}`;
}

/** When present, the same shape as `requireAddress`; when absent, `undefined`. */
function isOptionalAddress(value: string | undefined, name: string): `0x${string}` | undefined {
  return (value ?? '').trim().length === 0 ? undefined : requireAddress(value, name);
}

/** The node id the operator claims for this device; must be a non-negative integer. */
function requireNodeId(value: string | undefined): bigint {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return 1n;
  if (raw !== '1') {
    throw new Error('ARCHCORE_NODE_ID must be 1 for P0');
  }
  return BigInt(raw);
}

/**
 * The provider key is enforced after the chain object is built, because the
 * requirement applies whether the key was just parsed or came in another way.
 * The shape check is the whole of it: a key of the wrong length fails fast
 * here rather than surfacing later as an opaque signing failure on a rental
 * the operator has already paid for.
 */
function requirePrivateKey(value: string | undefined): `0x${string}` | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      `PROVIDER_PRIVATE_KEY must be a 32-byte hex private key (0x + 64 hex chars), got a ` +
        `value of the wrong length or shape`,
    );
  }
  return trimmed as `0x${string}`;
}

/** Any decimal epoch-seconds override must be a whole, positive number. */
function requirePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive whole number, got: ${value}`);
  }
  return Number(raw);
}

function requireBoundedInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got: ${value}`);
  }
  const num = Number(raw);
  if (num < min || num > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got: ${num}`);
  }
  return num;
}

export function parseAutoSettle(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`AGENT_AUTO_SETTLE must be "true" or "false" if set; received ${JSON.stringify(value)}`);
}

export function validateAndResolveSettlementDbPath(
  value: string | undefined,
  baseDir: string = process.cwd(),
): string {
  if (value !== undefined && value.trim().length === 0) {
    throw new Error('AGENT_SETTLEMENT_DB_PATH cannot be empty if specified');
  }
  const raw = (value ?? '').trim();
  if (raw.includes('://')) {
    throw new Error(`AGENT_SETTLEMENT_DB_PATH cannot be a URL: ${raw}`);
  }

  const resolved = raw.length > 0 ? resolve(baseDir, raw) : resolve(baseDir, 'apps/agent/data/settlement.sqlite');

  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new Error(`AGENT_SETTLEMENT_DB_PATH cannot resolve to a directory: ${resolved}`);
  }

  // Ensure resolved path is not inside apps/web/public
  const resolvedLower = resolved.toLowerCase();
  const webPublicCandidates = [
    resolve(baseDir, 'apps', 'web', 'public').toLowerCase(),
    resolve(__dirname, '..', '..', 'apps', 'web', 'public').toLowerCase(),
    resolve(__dirname, '..', '..', '..', 'apps', 'web', 'public').toLowerCase(),
  ];

  const isInWebPublic = (p: string) => {
    if (p.includes('/apps/web/public') || p.endsWith('/apps/web/public')) {
      return true;
    }
    for (const cand of webPublicCandidates) {
      if (p === cand || p.startsWith(cand + '/')) {
        return true;
      }
    }
    return false;
  };

  if (isInWebPublic(resolvedLower)) {
    throw new Error('AGENT_SETTLEMENT_DB_PATH cannot be placed inside web public directory');
  }

  // Check parent directory and symlinks
  const parentDir = dirname(resolved);
  if (existsSync(parentDir)) {
    try {
      const realParent = realpathSync(parentDir).toLowerCase();
      if (isInWebPublic(realParent)) {
        throw new Error('AGENT_SETTLEMENT_DB_PATH parent directory resolves inside web public directory');
      }
    } catch {
      // ignore realpath errors
    }
  } else {
    try {
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    } catch {
      // Ignore directory creation failure during static path validation (e.g. unprivileged tests)
    }
  }


  return resolved;
}

function browserRpcOrigin(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value || DEFAULT_RPC_URL); }
  catch { throw new Error('NEXT_PUBLIC_RH_RPC_URL must be a credential-free HTTP(S) origin.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('NEXT_PUBLIC_RH_RPC_URL must be credential-free, with no path, query, or fragment.');
  }
  return url.origin;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const missing = REQUIRED_ENV.filter((key) => !env[key] || env[key]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(
      `Agent cannot start: missing required environment: ${missing.join(', ')}. ` +
        `Configure the required values using .env.example and the active operator setup guidance, then retry.`,
    );
  }

  const allowedOrigins = (env.AGENT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const audience = (env.AGENT_AUDIENCE ?? '').trim();
  // The audience is part of every EIP-712 challenge the node signs, and it is
  // the only thing binding a signature to this deployment's public origin. It
  // must exist whether or not CORS is configured: with it empty, a challenge
  // minted with `agentAudience: ''` would still verify, so any frontend on any
  // origin could hold a session.
  if (audience.length === 0) {
    throw new Error(
      'AGENT_AUDIENCE is required: the EIP-712 audience binds every challenge to this ' +
        "node's canonical origin and must be shared with the frontend. Set it even when " +
        'AGENT_ALLOWED_ORIGINS is empty.',
    );
  }
  // And it must be one exact origin, not a prefix or a pattern. The comparison
  // on the other side of the wire is `challenge.audience !== config.audience`
  // — a byte-for-byte equality — so a value that parses to something other than
  // a single `scheme://host[:port]` triple would mint a challenge that no honest
  // frontend can reproduce, and a wildcard would accept every origin at once.
  //
  // The rule is `new URL(value).origin === value`, re-serialised. That one
  // equality is what rejects a bare hostname (`new URL` throws), a trailing
  // path, a trailing slash, a query, a fragment, and embedded userinfo, while
  // accepting exactly what a browser's `location.origin` produces — which is the
  // value the frontend has to reproduce to sign a challenge.
  const audienceError = () =>
    new Error(
      `AGENT_AUDIENCE must be exactly one origin (scheme://host[:port]) with no path, ` +
        `query or fragment: ${audience}. Use the exact https origin of the production ` +
        `frontend, or the exact http loopback origin used in development.`,
    );
  let parsedAudience: URL;
  try {
    parsedAudience = new URL(audience);
  } catch {
    throw audienceError();
  }
  // `origin` lowercases the host and drops a default port, so the equality also
  // rejects a host that differs only by case or by a spelled-out default port —
  // either of which would be a different challenge from the one the frontend
  // signs. Two values need an explicit refusal rather than a serialisation
  // comparison: a wildcard label, which `new URL` happily parses as an origin,
  // and an opaque scheme, whose `origin` serialises to `null`.
  if (
    parsedAudience.host.includes('*') ||
    parsedAudience.origin === 'null' ||
    parsedAudience.origin !== audience
  ) {
    throw audienceError();
  }
  // Only two schemes are legitimate: https for the production origin, and http
  // for loopback development. The production network path is operator-configured;
  // this validation does not imply a particular tunnel or private-network product.
  // Anything else (including a custom scheme that is not a browser origin) is
  // rejected so the audience matches the browser's serialized origin.
  const isProduction = parsedAudience.protocol === 'https:';
  const isLoopback =
    parsedAudience.protocol === 'http:' &&
    (parsedAudience.hostname === 'localhost' ||
      parsedAudience.hostname === '127.0.0.1' ||
      parsedAudience.hostname === '[::1]');
  if (!isProduction && !isLoopback) {
    throw audienceError();
  }

  const chain = {
    // Chain ID is frozen, not configurable. It is one of the four fields of the
    // EIP-712 domain every challenge is signed over, so a node pointed at a
    // different chain id would mint challenges no honest frontend can sign and
    // would read rentals off the wrong manager. A value that disagrees with the
    // frozen id is a misconfiguration and is reported rather than silently
    // overridden.
    chainId: requireFrozenChainId(env.RH_CHAIN_ID),
    rpcUrl: env.RH_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
    rentalManagerAddress: requireAddress(env.RENTAL_MANAGER_ADDRESS, 'RENTAL_MANAGER_ADDRESS'),
    computeAssetAddress: isOptionalAddress(
      (env.COMPUTE_ASSET_ADDRESS ?? '').trim() || undefined,
      'COMPUTE_ASSET_ADDRESS',
    ),
    nodeId: requireNodeId(env.ARCHCORE_NODE_ID),
    providerPrivateKey: requirePrivateKey(env.PROVIDER_PRIVATE_KEY),
    abiDir: env.ARCHCORE_ABI_DIR || undefined,
    rentalManagerAbiPath: env.RENTAL_MANAGER_ABI_PATH || undefined,
    computeAssetAbiPath: env.COMPUTE_ASSET_ABI_PATH || undefined,
    explorerUrl: env.RH_EXPLORER_URL || undefined,
  };

  if (chain.providerPrivateKey === undefined) {
    // Hard requirement of outcome #2: the agent itself calls startRental().
    throw new Error(
      'PROVIDER_PRIVATE_KEY is required: outcome #2 needs the agent to call startRental() itself. ' +
        'Use a throwaway testnet key with no funds beyond gas.',
    );
  }

  // Rental economics are not Agent configuration. The plan a renter picks, the
  // amount escrowed, and every deadline come from authoritative chain data read
  // through the normalized Role 2 client (`getRental` -> `ChainRental`), never
  // from a fixed ETH price or an operator-supplied duration here. A price or a
  // duration configured on the Agent could disagree with the contract and the
  // contract's answer is the one that settles the escrow.

  // Defaults are loopback-only: an operator who starts the node without
  // setting `AGENT_HOST` gets a socket reachable from the same device, not one
  // bound to every interface. Any remote/private ingress is configured and
  // verified by the operator; this Agent does not prescribe its transport.
  const rawMode = env.INFERENCE_BACKEND_MODE?.trim();
  if (rawMode !== 'demo') {
    throw new Error(
      `INFERENCE_BACKEND_MODE must be 'demo' for P0 (got: ${rawMode ? `'${rawMode}'` : 'missing'}). ` +
        `Fill from .env.example, then retry.`,
    );
  }
  const host = (env.AGENT_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  if (env.USDG_ADDRESS && env.USDG_ADDRESS.toLowerCase() !== USDG_ADDRESS.toLowerCase()) {
    throw new Error('USDG_ADDRESS must match the frozen P0 payment token');
  }

  return {
    host,
    port: requirePositiveInteger(env.AGENT_PORT, 'AGENT_PORT', 8787),
    logLevel: (env.AGENT_LOG_LEVEL ?? 'info').trim() || 'info',
    allowedOrigins,
    audience,
    chain,
    nodeId: chain.nodeId,
    paymentToken: USDG_ADDRESS,
    paymentSymbol: 'USDG',
    interfaceVersion: '0.5',
    inferenceMode: 'demo',
    browserRpcOrigin: browserRpcOrigin(env.NEXT_PUBLIC_RH_RPC_URL),
    providerPrivateKey: chain.providerPrivateKey,
    watchIntervalMs: requirePositiveInteger(env.AGENT_WATCH_INTERVAL_MS, 'AGENT_WATCH_INTERVAL_MS', 5000),
    autoStartEnabled: (env.AGENT_AUTO_START ?? 'true').toLowerCase() !== 'false',
    autoSettlementEnabled: parseAutoSettle(env.AGENT_AUTO_SETTLE),
    settleRetryMaxAttempts: requireBoundedInteger(env.AGENT_SETTLE_MAX_ATTEMPTS, 'AGENT_SETTLE_MAX_ATTEMPTS', 5, 1, 20),
    settleRetryDelayMs: requireBoundedInteger(env.AGENT_SETTLE_RETRY_DELAY_MS, 'AGENT_SETTLE_RETRY_DELAY_MS', 2000, 500, 60000),
    settlementDbPath: validateAndResolveSettlementDbPath(env.AGENT_SETTLEMENT_DB_PATH),
    settleClaimLeaseMs: requireBoundedInteger(env.AGENT_SETTLE_CLAIM_LEASE_MS, 'AGENT_SETTLE_CLAIM_LEASE_MS', 30000, 5000, 300000),
    settleBusyTimeoutMs: requireBoundedInteger(env.AGENT_SETTLE_BUSY_TIMEOUT_MS, 'AGENT_SETTLE_BUSY_TIMEOUT_MS', 5000, 500, 60000),
    limits: { ...DEFAULT_LIMITS },
    gpu: {
      expectedName: env.PROVIDER_GPU_NAME ?? 'NVIDIA GeForce GTX 1650',
      maxTemperatureC: Number(env.PROVIDER_GPU_MAX_TEMP_C ?? 83),
      minFreeVramMb: Number(env.PROVIDER_GPU_MIN_FREE_VRAM_MB ?? 300),
    },
  };
}
