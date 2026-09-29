/**
 * HTTP client for the Provider Agent.
 *
 * In production, the browser reaches the Provider Agent through an operator-configured
 * private OmniRoute route (PRD v0.5 §13). When the web app is served behind the private
 * OmniRoute gateway (same-origin reverse proxy), requests are sent to the page's own origin.
 * In local development, the client connects to the local Agent at http://<hostname>:8787.
 * No public Agent URLs, third-party tunnels, or direct backend URLs are ever used.
 *
 * The bearer token lives only in the caller's memory. This module never writes
 * it to `localStorage`, `sessionStorage` or a cookie, and clears it whenever the
 * Agent says the session or the rental is no longer good.
 */

import { AbiError, normaliseAbi, parseAgentConfig, type AbiFunctionEntry, type AgentConfig } from './config';

export type { AgentConfig };

/** Chain parameters and the RentalManager identity, from `GET /config`. */
export interface ChainIdentity {
  config: AgentConfig;
}

export class AgentError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

/** Status codes that mean "this session is over", not "that request failed". */
const SESSION_DEAD = new Set([401, 409]);

/**
 * Resolves the Agent base URL for local development or production.
 *
 * Local development (localhost / 127.0.0.1) routes to the local Agent on port 8787 by default,
 * or safely validates a test fixture origin injected via window.__ARCHCORE_TEST_AGENT_ORIGIN__.
 * Query parameters and browser links are never permitted to select the Agent endpoint.
 * Production routes always use location.origin (private OmniRoute reverse proxy), completely
 * ignoring any test global overrides.
 */
export function agentOrigin(location: { hostname: string; origin: string; search?: string }): string {
  const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isLocalDev) {
    return location.origin;
  }

  const globalScope: any = typeof window !== 'undefined' ? window : globalThis;
  const rawTestOrigin = globalScope?.__ARCHCORE_TEST_AGENT_ORIGIN__;
  if (typeof rawTestOrigin === 'string') {
    try {
      const parsed = new URL(rawTestOrigin);
      if (
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === '' &&
        parsed.port !== '' &&
        /^\d+$/.test(parsed.port) &&
        parsed.origin === `${parsed.protocol}//${parsed.host}`
      ) {
        return parsed.origin;
      }
    } catch {
      /* malformed or invalid URL */
    }
  }

  return `http://${location.hostname}:8787`;
}

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Sends `Authorization: Bearer <token>`; throws when no session is held. */
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * One Agent request.
 *
 * The response body is read as text first and parsed afterwards, so a non-JSON
 * error page still yields a readable message instead of a parse failure that
 * hides the status code.
 */
export async function callAgent(
  origin: string,
  path: string,
  { method = 'GET', body, token, signal }: CallOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined && token !== null) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AgentError(`Cannot reach the agent at ${origin}: ${String(error)}`, 0);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const detail = typeof record.error === 'string'
      ? record.error
      : typeof record.message === 'string'
        ? record.message
        : text.slice(0, 200) || `HTTP ${response.status}`;
    throw new AgentError(`HTTP ${response.status} ${detail}`, response.status);
  }

  return parsed;
}

/** True when the Agent's answer means the session must be forgotten. */
export function isSessionDead(error: unknown): boolean {
  if (error instanceof AgentError) return SESSION_DEAD.has(error.status);
  return error instanceof Error && /^HTTP (401|409) /.test(error.message);
}

export interface AgentHealth {
  status: 'ok' | 'degraded';
  checks: ReadonlyArray<{ name: string; status: 'ok' | string; detail?: string }>;
  reservation?: {
    state?: string;
    rentalId?: string;
    nodeId?: string;
    startDeadline?: number;
    expiresAt?: number;
    error?: string;
  };
}

/**
 * Reads `GET /config`.
 *
 * A non-2xx status is surfaced as degraded, never as healthy: the page must not
 * offer a rent button when the Agent could not tell it what the contract is.
 */
export async function fetchConfig(origin: string, signal?: AbortSignal): Promise<AgentConfig> {
  const raw = await callAgent(origin, '/config', { signal });
  return parseAgentConfig(raw);
}

/**
 * Reads `GET /health` and refuses to call a failing response healthy.
 *
 * The Agent answers `503` with a JSON body whose `status` field can still say
 * `ok` while a check has failed. Parsing that body and trusting the word would
 * show a node as operational when the Agent itself has said it is not, which is
 * how a renter pays for a rental that cannot run. Any non-2xx status — and a
 * body that cannot be read — is degraded, named as such.
 */
export async function fetchHealth(origin: string, signal?: AbortSignal): Promise<AgentHealth> {
  let response: Response;
  try {
    response = await fetch(`${origin}/health`, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AgentError(`Cannot reach the agent at ${origin}: ${String(error)}`, 0);
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const health = parsed === null ? degradedHealth(`HTTP ${response.status}`) : parseHealth(parsed);
    return { ...health, status: 'degraded' };
  }
  if (parsed === null) return degradedHealth('health response was not JSON');
  return parseHealth(parsed);
}

/** A health reading with nothing to report except that the Agent did not answer. */
function degradedHealth(detail: string): AgentHealth {
  return { status: 'degraded', checks: [{ name: 'agent', status: 'error', detail }] };
}

/**
 * Loads and validates the RentalManager ABI artifact from the Web asset origin.
 *
 * In production web hosting or local development, the artifact is served from the
 * web asset origin at `/rental-manager.json` (copied from packages/abi at build time).
 * Fails closed if the artifact is unavailable, malformed, or missing required P0 methods.
 */
export async function loadAbi(webAssetOrigin: string, signal?: AbortSignal): Promise<readonly AbiFunctionEntry[]> {
  const url = `${webAssetOrigin.replace(/\/$/, '')}/rental-manager.json`;
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AbiError(`Cannot reach RentalManager ABI at ${url}: ${String(error)}`);
  }
  if (!response.ok) {
    throw new AbiError(`Failed to load RentalManager ABI from ${url} (HTTP ${response.status})`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new AbiError(`RentalManager ABI at ${url} is not valid JSON: ${String(error)}`);
  }
  return normaliseAbi(raw);
}

export interface AgentNode {
  nodeId: bigint;
  provider?: string;
  name: string;
  active: boolean;
}

export function parseNode(raw: unknown): AgentNode {
  if (typeof raw !== 'object' || raw === null) throw new AgentError('GET /node returned no object', 0);
  const body = raw as Record<string, unknown>;
  const nodeId = body.nodeId;
  if (typeof nodeId !== 'string' || !/^\d+$/.test(nodeId)) {
    throw new AgentError('GET /node returned an unusable nodeId', 0);
  }
  return {
    nodeId: BigInt(nodeId),
    provider: typeof body.provider === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.provider) ? body.provider : undefined,
    name: typeof body.name === 'string' ? body.name : '',
    active: body.active === true,
  };
}

/** Parses `GET /health`, keeping `degraded` distinguishable from `ok`. */
export function parseHealth(raw: unknown): AgentHealth {
  if (typeof raw !== 'object' || raw === null) {
    throw new AgentError('GET /health returned no object', 0);
  }
  const body = raw as Record<string, unknown>;
  const checksValue = Array.isArray(body.checks) ? body.checks : [];
  const checks = checksValue.map((entry) => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : 'unknown',
      status: typeof record.status === 'string' ? record.status : 'unknown',
      detail: typeof record.detail === 'string' ? record.detail : undefined,
    };
  });
  // Local demo checks (agent, rpc, backend) are required; privateRoute and gpu can be unknown.
  const requiredChecks = ['agent', 'rpc', 'backend'];
  const requiredPass = checks.length === 0 || checks
    .filter((c) => requiredChecks.includes(c.name))
    .every((c) => c.status === 'ok');

  return {
    status: body.status === 'ok' && requiredPass ? 'ok' : 'degraded',
    checks,
    reservation: (typeof body.reservation === 'object' && body.reservation !== null
      ? body.reservation
      : undefined) as AgentHealth['reservation'],
  };
}

export interface GpuStatus {
  present: boolean;
  name?: string;
  temperatureC?: number;
  mode?: string;
  backend?: string;
  ready?: boolean;
}

export function parseGpu(raw: unknown): GpuStatus {
  if (typeof raw !== 'object' || raw === null) return { present: false };
  const body = raw as Record<string, unknown>;
  return {
    present: body.present === true || body.ready === true,
    name: typeof body.name === 'string' ? body.name : undefined,
    temperatureC: typeof body.temperatureC === 'number' ? body.temperatureC : undefined,
    mode: typeof body.mode === 'string' ? body.mode : undefined,
    backend: typeof body.backend === 'string' ? body.backend : undefined,
    ready: body.ready === true,
  };
}

export interface Challenge {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export function parseChallenge(raw: unknown): Challenge {
  if (typeof raw !== 'object' || raw === null) {
    throw new AgentError('POST /auth/challenge returned no object', 0);
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.domain !== 'object' || body.domain === null) {
    throw new AgentError('POST /auth/challenge returned no EIP-712 domain', 0);
  }
  if (typeof body.types !== 'object' || body.types === null) {
    throw new AgentError('POST /auth/challenge returned no EIP-712 types', 0);
  }
  if (typeof body.primaryType !== 'string') {
    throw new AgentError('POST /auth/challenge returned no primaryType', 0);
  }
  if (typeof body.message !== 'object' || body.message === null) {
    throw new AgentError('POST /auth/challenge returned no message', 0);
  }
  return {
    domain: body.domain as Record<string, unknown>,
    types: body.types as Record<string, unknown>,
    primaryType: body.primaryType,
    message: body.message as Record<string, unknown>,
  };
}

export interface Session {
  token: string;
  rentalId: bigint;
  expiresAt: number;
}

export function parseSession(raw: unknown): Session {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AgentError('POST /auth/verify returned invalid JSON (expected an object)', 0);
  }
  const body = raw as Record<string, unknown>;

  // Reject unexpected schema keys that the ledger does not permit (including sessionToken alias)
  const allowedKeys = new Set(['token', 'rentalId', 'expiresAt']);
  const extraKeys = Object.keys(body).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    throw new AgentError(
      `POST /auth/verify returned unexpected fields: ${extraKeys.join(', ')}`,
      0,
    );
  }

  // Must have 'token' as non-empty string
  if (!('token' in body)) {
    throw new AgentError('POST /auth/verify missing required field: token', 0);
  }
  if (typeof body.token !== 'string' || body.token.trim().length === 0) {
    throw new AgentError('POST /auth/verify returned invalid or empty token', 0);
  }

  // Must have 'rentalId' as a positive decimal string (no trimming or silent normalization)
  if (!('rentalId' in body)) {
    throw new AgentError('POST /auth/verify missing required field: rentalId', 0);
  }
  if (typeof body.rentalId !== 'string') {
    throw new AgentError('POST /auth/verify returned numeric or non-string rentalId', 0);
  }
  if (!/^[1-9]\d*$/.test(body.rentalId)) {
    throw new AgentError('POST /auth/verify returned malformed or non-positive decimal rentalId', 0);
  }

  // Must have 'expiresAt' as a decimal Unix-seconds string (no trimming or silent normalization)
  if (!('expiresAt' in body)) {
    throw new AgentError('POST /auth/verify missing required field: expiresAt', 0);
  }
  if (typeof body.expiresAt !== 'string') {
    throw new AgentError('POST /auth/verify returned numeric or non-string expiresAt', 0);
  }
  if (!/^[1-9]\d*$/.test(body.expiresAt)) {
    throw new AgentError('POST /auth/verify returned malformed decimal string for expiresAt', 0);
  }

  const numExpires = Number(body.expiresAt);
  if (!Number.isSafeInteger(numExpires) || numExpires <= 0) {
    throw new AgentError('POST /auth/verify returned zero or invalid expiresAt', 0);
  }

  // Reject milliseconds or timestamps beyond valid Unix seconds range (no guessing or automatic conversion)
  if (numExpires >= 100_000_000_000) {
    throw new AgentError('POST /auth/verify returned millisecond timestamp; expected Unix seconds string', 0);
  }

  // Held in memory by the caller only; this module never stores it anywhere.
  return {
    token: body.token,
    rentalId: BigInt(body.rentalId),
    expiresAt: numExpires,
  };
}
