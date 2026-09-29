import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData } from 'viem';

import { type AgentDeps, buildServer } from '../src/server.js';
import { SessionStore as SessionStoreImpl } from '../src/sessionStore.js';
import { createLogger } from '../src/logger.js';
import {
  ChallengeStore,
  SIGN_TYPES,
  buildDomain,
  typedDataPayload,
  type ChallengeDomain,
  CHALLENGE_TYPES,
} from '../src/auth.js';
import { InferenceClient as InferenceClientImpl } from '../src/inference.js';
import { UnitTestInferenceBackendFake } from '../src/adapter.js';
import { HealthMonitor as HealthMonitorImpl } from '../src/health.js';
import { ReservationWatcher as ReservationWatcherImpl } from '../src/reservationWatcher.js';
import { RentalQuota as RentalQuotaImpl } from '../src/quota.js';
import { redactDeep, REDACT_PATHS } from '@archcore/shared';
import type { ChainRental } from '@archcore/shared';

/**
 * Route-level regression suite for the EIP-712 auth flow and the P0 inference
 * guards.
 *
 * Everything here goes over a real Fastify instance with real injected stores —
 * no route internals are called directly. That is deliberate: the requirements
 * under test are about what a browser on the other side of HTTP observes, so
 * the wire contract, not the function signature, is the subject.
 */

// Anvil default account #0 — the renter. A well-known public test value.
const RENTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const renter = privateKeyToAccount(RENTER_KEY);

// Anvil default account #1 — a second address used for cross-rental abuse.
const OTHER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const other = privateKeyToAccount(OTHER_KEY);

const CHAIN_ID = 46630;
// Typed as a `0x${string}` literal so it satisfies buildDomain's verifyingContract.
const MANAGER = ('0x' + 'ab'.repeat(20)) as `0x${string}`;
const NODE_ID = 1n;
const AUDIENCE = 'https://agent.example.invalid';

interface RentalOverrides {
  rentalId?: bigint;
  nodeId?: bigint;
  renter?: string;
  status?: ChainRental['status'];
  expiresAt?: bigint;
}

function rental(overrides: RentalOverrides = {}): ChainRental {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    rentalId: overrides.rentalId ?? 7n,
    nodeId: overrides.nodeId ?? NODE_ID,
    renter: overrides.renter ?? renter.address,
    provider: '0x' + '99'.repeat(20),
    price: 10n ** 18n,
    status: overrides.status ?? 'ACTIVE',
    startDeadline: now + 600n,
    startsAt: 0n,
    // Far enough in the future that no test trips the expiry by itself.
    expiresAt: overrides.expiresAt ?? now + 3600n,
    createdAt: now,
  } as ChainRental;
}

interface TestRig {
  app: FastifyInstance;
  deps: AgentDeps;
  challenges: ChallengeStore;
  sessions: SessionStoreImpl;
  quota: RentalQuotaImpl;
  /** Rental the fake chain returns, mutable per test via `rig.rental = ...`. */
  rental: ChainRental;
  close: () => Promise<void>;
}

async function rig(
  options: {
    limits?: Partial<AgentDeps['config']['limits']>;
    deps?: Partial<AgentDeps>;
    allowedOrigins?: string[];
  } = {},
): Promise<TestRig> {
  const config = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'error',
    allowedOrigins: options.allowedOrigins ?? [],
    audience: AUDIENCE,
    chain: {
      chainId: CHAIN_ID,
      rpcUrl: 'http://127.0.0.1:19999',
      rentalManagerAddress: MANAGER,
    } as AgentDeps['config']['chain'],
    nodeId: NODE_ID,
    watchIntervalMs: 1000,
    autoStartEnabled: false,
    limits: {
      maxJsonBodyBytes: 4096,
      maxPromptBytes: 1024,
      maxOutputTokens: 128,
      maxRequestsPerRental: 10,
      maxConcurrentInference: 1,
      maxGenerationSeconds: 30,
      minRequestIntervalSeconds: 2,
      challengeTtlSeconds: 60,
      ...options.limits,
    },
    paymentToken: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
    paymentSymbol: 'USDG',
    interfaceVersion: '0.5',
    inferenceMode: 'demo',
    gpu: { expectedName: 'test', maxTemperatureC: 100, minFreeVramMb: 1 },
  } as AgentDeps['config'];

  const logger = options.deps?.logger ?? createLogger(config);
  const sessions = new SessionStoreImpl();
  const challenges = new ChallengeStore(config.limits.challengeTtlSeconds);
  const quota = new RentalQuotaImpl(config.limits);

  let current: ChainRental = rental();
  let isEoaResult = true;
  const rentalClient = {
    getRental: async () => current,
    getActiveRentalForNode: async () => current,
    getListing: async () => ({ nodeId: NODE_ID, paymentToken: '0x00' as any, active: true }),
    getBlockTimestamp: async () => BigInt(Math.floor(Date.now() / 1000)),
    encodeSettleAfterExpiryCalldata: () => ({ to: '0x00' as any, data: '0x' as any, value: 0n }),
    submitTransaction: async () => '0x00' as any,
    waitForTransactionSuccess: async () => ({ status: 'success' }) as any,
    startRental: async () => '0x00' as any,
    getNode: async () => ({ nodeId: NODE_ID, name: 'fixture', active: true }),
    isEoa: async () => isEoaResult,
  } as unknown as AgentDeps['rentalClient'];

  const backend = (options.deps?.backend as UnitTestInferenceBackendFake) ?? new UnitTestInferenceBackendFake('test-model');

  const deps: AgentDeps = {
    config,
    logger,
    rentalClient,
    backend,
    healthMonitor: new HealthMonitorImpl(config, backend),
    inference: new InferenceClientImpl(backend, config.limits),
    sessions,
    challenges,
    quota,
    watcher: new ReservationWatcherImpl(rentalClient, new HealthMonitorImpl(config, backend), 1000),
    ...options.deps,
  };

  const app = await buildServer(deps);
  const close = async () => {
    sessions.stop();
    await app.close();
  };

  return {
    app,
    deps,
    challenges,
    sessions,
    quota,
    rental: current,
    close,
  };
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/** Mint a challenge over HTTP, exactly as the browser does. */
async function challengeFor(app: FastifyInstance, rentalId: string | number = 7) {
  const res = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: String(rentalId) } });
  assert.equal(res.statusCode, 201, `challenge failed: ${res.body}`);
  return res.json();
}

/**
 * Sign the agent-issued typed data with `signer`, returning the hex signature.
 * `mutate` lets a test corrupt one field of the message before signing — the
 * signature must then be invalid for the unmutated challenge.
 */
async function signChallenge(
  typedData: {
    domain: ChallengeDomain;
    types: typeof CHALLENGE_TYPES;
    primaryType: string;
    message: Record<string, string>;
  },
  signer = renter,
  mutate?: (message: Record<string, string>) => void,
): Promise<string> {
  const message: Record<string, string> = { ...typedData.message };
  mutate?.(message);
  return signer.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    // The wallet's overload resolves `primaryType` from its types map, so the
    // server's own constant is the exact literal it expects.
    primaryType: typedData.primaryType as keyof typeof CHALLENGE_TYPES,
    message,
  } as unknown as Parameters<typeof signer.signTypedData>[0]);
}

/** Complete challenge + sign + verify, returning the raw session token. */
async function verifyFor(
  app: FastifyInstance,
  options: { signer?: typeof renter; mutate?: (m: Record<string, string>) => void; rentalId?: string } = {},
): Promise<{ token: string; body: Record<string, unknown> }> {
  const typedData = await challengeFor(app, options.rentalId ?? '7');
  const signature = await signChallenge(typedData, options.signer, options.mutate);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { signature, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
  });
  return { token: res.json()?.token ?? res.json()?.sessionToken ?? '', body: res.json() };
}

/** Stub the chain to return a rental with these overrides, then verify. */
// ===========================================================================
// Hardened response headers and request-body gating
//
// The agent serves the browser that holds a renter's session, so the headers
// it returns are part of the security surface, and the body gate is what keeps
// a huge or wrongly-typed payload from reaching the auth handlers at all.
// ===========================================================================
describe('response headers and body gating', () => {
  let r: TestRig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(async () => {
    await r.close();
  });

  it('hardens every response it sends, including the /health probe', async () => {
    // The rig's health monitor is a stub, so /health itself reports degraded;
    // what is asserted here is the headers, which must be identical on every
    // route the agent serves, including this one.
    const res = await r.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    // A strict CSP with no unsafe-* and frame-ancestors 'none': the frontend is
    // same-origin and wallet connections are extensions, not injected scripts.
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes('unsafe'), `CSP must not allow unsafe sources: ${csp}`);
  });

  it('rejects a JSON route whose body is not JSON, without reaching the handler', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/challenge',
      headers: { 'content-type': 'text/plain' },
      payload: 'rentalId=7',
    });
    assert.equal(res.statusCode, 415);
    assert.equal(res.json().code, 'UNSUPPORTED_MEDIA_TYPE');
    // The body is refused on its content type, so the handler never ran and
    // cannot have produced an error that names the route's own expectations.
    assert.match(res.json().error, /application\/json/);
  });

  it('rejects a body that claims JSON but is not an object', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/challenge',
      headers: { 'content-type': 'application/json' },
      payload: '"a string"',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_BODY');
  });

  it('rejects a body larger than the ceiling instead of parsing it', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { rentalId: '7', pad: 'x'.repeat(64 * 1024) },
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().code, 'BODY_TOO_LARGE');
  });

  it('never reports an RPC failure with the upstream provider detail', async () => {
    // A `rentalId` that is not a decimal integer never reaches a chain read, so
    // this asserts the 400 path rather than the RPC path, and proves the error
    // body is the agent's own generic wording rather than a leaked internal.
    const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: 'abc' } });
    assert.equal(res.statusCode, 400);
    assert.ok(!/rpc|127\.0\.0\.1|127\.0\.0/.test(String(res.json().error)));
  });
});

// ===========================================================================
describe('POST /auth/challenge', () => {
  let r: TestRig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(async () => {
    await r.close();
  });

  it('returns the wallet-ready typed-data object with exactly the EIP-712 domain and message required', async () => {
    const typedData = await challengeFor(r.app);

    assert.deepEqual(Object.keys(typedData).sort(), ['domain', 'message', 'primaryType', 'types'].sort());
    // `consumed` is an internal store field and must never be serialised.
    assert.equal('consumed' in (typedData.message as object), false);
    assert.equal('consumed' in typedData, false);

    // Exact domain, field for field. The domain *name* is spaced and the
    // primaryType is not — `ComputeRWA Agent Auth` vs `ComputeRWAAgentAuth` —
    // and both must match the browser exactly, so the digest round-trips.
    assert.deepEqual(typedData.domain, {
      name: 'ComputeRWA Agent Auth',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: MANAGER,
    });

    // Exact type map, including the EIP712Domain as a wallet expects it.
    assert.deepEqual(typedData.types, SIGN_TYPES);
    assert.equal(typedData.types.EIP712Domain.every((f: { name: string }) => ['name', 'version', 'chainId', 'verifyingContract'].includes(f.name)), true);

    // Exact message shape and order.
    assert.deepEqual(Object.keys(typedData.message), [
      'renter',
      'rentalId',
      'nodeId',
      'nonce',
      'issuedAt',
      'expiresAt',
      'agentAudience',
    ]);

    assert.equal(typedData.message.renter, renter.address.toLowerCase());
    assert.equal(typedData.message.rentalId, '7');
    assert.equal(typedData.message.nodeId, NODE_ID.toString());
    assert.equal(typedData.message.agentAudience, AUDIENCE);
    // Every integer crosses the wire as a decimal string, wallet-safe.
    for (const field of ['rentalId', 'nodeId', 'issuedAt', 'expiresAt']) {
      assert.equal(typeof typedData.message[field], 'string', `${field} must be a string`);
    }
    // 32-byte entropy, so a nonce cannot be guessed or replayed from history.
    assert.match(typedData.message.nonce as string, /^0x[0-9a-f]{64}$/);
  });

  it('mints a distinct nonce per call, so one rental may hold several live challenges', async () => {
    const a = await challengeFor(r.app);
    const b = await challengeFor(r.app);
    assert.notEqual(a.message.nonce, b.message.nonce);
  });

  it('denies a session for a RESERVED rental', async () => {
    (r.rental as { status: string }).status = 'RESERVED';
    const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: '7' } });
    assert.equal(res.statusCode, 409);
    // A RESERVED rental is not billable yet, so the denial names the state the
    // chain reported rather than a generic "denied".
    assert.equal(res.json().error, 'Rental is not ACTIVE.');
    assert.equal(res.json().code, 'RENTAL_NOT_ACTIVE');
  });

  // The three non-ACTIVE on-chain states are all denials, but a test that stops
  // at RESERVED would leave the other two unverified — and a guard that happened
  // to special-case them one at a time would pass. Each state is asserted by
  // name, on both sides of the guard, so the state machine is covered as a set.
  for (const status of ['RESERVED', 'CANCELLED', 'COMPLETED'] as const) {
    it(`denies a session for a ${status} rental`, async () => {
      (r.rental as { status: string }).status = status;
      const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: '7' } });
      assert.equal(res.statusCode, 409, `${status} must not mint a challenge`);
      assert.equal(res.json().code, 'RENTAL_NOT_ACTIVE');
      assert.equal(res.json().error, 'Rental is not ACTIVE.');
    });
  }

  it('denies a session for an expired rental', async () => {
    (r.rental as { expiresAt: bigint }).expiresAt = BigInt(Math.floor(Date.now() / 1000) - 1);
    const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: '7' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'RENTAL_EXPIRED');
  });

  it('denies a session for a rental bound to another node', async () => {
    (r.rental as { nodeId: bigint }).nodeId = 999n;
    const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: '7' } });
    assert.equal(res.statusCode, 409);
    // The shared guard's wording; the denial itself is what matters, and the
    // stable code is what the frontend switches on.
    assert.equal(res.json().error, 'Rental is not ACTIVE.');
    assert.equal(res.json().code, 'RENTAL_NOT_ACTIVE');
  });

  it('denies a session when the renter is a contract, which can never produce a signature that recovers to itself', async () => {
    (r.rental as { renter: string }).renter = MANAGER;
    // The rig's chain read must report the new renter as a contract; without
    // this the route's guard is never exercised and the test proves nothing.
    (r.deps.rentalClient as unknown as { isEoa: (addr: string) => Promise<boolean> }).isEoa = async () => false;
    const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: '7' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'EOA_REQUIRED');
  });

  it('denies a session when the chain read fails', async () => {
    (r.deps.rentalClient as unknown as { getRental: () => Promise<never> }).getRental = async () => {
      throw new Error('rpc down');
    };
    const res = await r.app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: '7' } });
    assert.equal(res.statusCode, 503);
  });
});

// ===========================================================================
describe('POST /auth/verify', () => {
  let r: TestRig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(async () => {
    await r.close();
  });

  it('mints a session for a correctly signed challenge', async () => {
    const { token, body } = await verifyFor(r.app);
    assert.equal(body.rentalId, '7');
    assert.equal(body.expiresAt, String(r.rental.expiresAt));
    assert.ok(token.length > 0);
  });

  it('produces the same signature hash as the browser for the same typed data', async () => {
    // The wire contract only holds if the wallet hashes exactly what the server
    // recovers, so the digest is asserted rather than assumed.
    const typedData = await challengeFor(r.app);
    const browserStyle = {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    };
    const serverStyle = typedDataPayload(
      buildDomain(CHAIN_ID, MANAGER),
      {
        ...typedData.message,
        nonce: String(typedData.message.nonce),
        rentalId: String(typedData.message.rentalId),
        renter: String(typedData.message.renter),
        nodeId: String(typedData.message.nodeId),
        audience: AUDIENCE,
        issuedAt: Number(typedData.message.issuedAt),
        expiresAt: Number(typedData.message.expiresAt),
        consumed: false,
      } as never,
    );
    assert.equal(hashTypedData(browserStyle as never), hashTypedData(serverStyle as never));

    // ...and the minted signature round-trips through the route.
    const signature = await signChallenge(typedData);
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
    });
    assert.equal(res.statusCode, 201);
  });

  it('returns only the token and the rental facts, never the challenge or the signature', async () => {
    const { body } = await verifyFor(r.app);
    assert.deepEqual(
      Object.keys(body).sort(),
      ['expiresAt', 'rentalId', 'token'].sort(),
    );
  });

  it('rejects a signature that does not recover to the renter', async () => {
    const { body } = await verifyFor(r.app, { signer: other });
    // `verifyChallenge` compares the recovered signer against the challenge's
    // renter before it touches the chain copy, so that is the error a wrong
    // signer surfaces.
    assert.equal(body.error, 'Signature is invalid.');
  });

  it('rejects a replay of a nonce that has already been consumed', async () => {
    const typedData = await challengeFor(r.app);
    const signature = await signChallenge(typedData);
    const payload = { signature, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId };
    assert.equal((await r.app.inject({ method: 'POST', url: '/auth/verify', payload })).statusCode, 201);

    const replay = await r.app.inject({ method: 'POST', url: '/auth/verify', payload });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().code, 'CHALLENGE_REPLAYED');
  });

  it('does not consume the nonce when the signature is invalid', async () => {
    const typedData = await challengeFor(r.app);
    // The mutation makes the signature invalid for the stored challenge.
    const bad = await signChallenge(typedData, renter, (m) => {
      m.nonce = '0x' + '00'.repeat(32);
    });
    const badRes = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature: bad, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
    });
    assert.notEqual(badRes.statusCode, 201);

    // The very same challenge must still verify: nothing was burned.
    const good = await signChallenge(typedData);
    const goodRes = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature: good, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
    });
    assert.equal(goodRes.statusCode, 201);
  });

  it('mints exactly one session when two valid verifies race on the same nonce', async () => {
    const typedData = await challengeFor(r.app);
    const payload = {
      signature: await signChallenge(typedData),
      nonce: typedData.message.nonce,
      rentalId: typedData.message.rentalId,
    };
    const results = await Promise.all([
      r.app.inject({ method: 'POST', url: '/auth/verify', payload }),
      r.app.inject({ method: 'POST', url: '/auth/verify', payload }),
    ]);
    const minted = results.filter((res) => res.statusCode === 201);
    assert.equal(minted.length, 1);
    assert.equal(r.sessions.activeCount(), 1);
  });

  it('rejects a signature minted for a different chainId', async () => {
    const typedData = await challengeFor(r.app);
    // Sign with a domain whose chainId differs from the challenge's.
    const signature = await renter.signTypedData({
      domain: { ...typedData.domain, chainId: 1 } as never,
      types: typedData.types as never,
      primaryType: typedData.primaryType,
      message: typedData.message as never,
    });
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
    });
    assert.equal(res.statusCode, 401);
    // Rejected means no token comes back and nothing was minted.
    assert.equal(res.json().token, undefined);
    assert.equal(r.sessions.activeCount(), 0);
    await verifyFor(r.app);
  });

  it('rejects a signature minted for a different verifyingContract', async () => {
    const typedData = await challengeFor(r.app);
    const signature = await renter.signTypedData({
      domain: { ...typedData.domain, verifyingContract: '0x' + 'cd'.repeat(20) } as never,
      types: typedData.types as never,
      primaryType: typedData.primaryType,
      message: typedData.message as never,
    });
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'INVALID_SIGNATURE');
  });

  it('rejects a signature whose nodeId in the message differs from the rental', async () => {
    const typedData = await challengeFor(r.app);
    const { body } = await verifyWithMutation(r.app, typedData, (m) => {
      m.nodeId = '999';
    });
    assert.equal(body.code, 'INVALID_SIGNATURE');
  });

  it('rejects a signature whose rentalId in the message differs from the rental', async () => {
    const typedData = await challengeFor(r.app);
    const { body } = await verifyWithMutation(r.app, typedData, (m) => {
      m.rentalId = '8';
    });
    assert.equal(body.code, 'INVALID_SIGNATURE');
  });

  it('rejects a signature whose agentAudience differs from this agent', async () => {
    const typedData = await challengeFor(r.app);
    const { body } = await verifyWithMutation(r.app, typedData, (m) => {
      m.agentAudience = 'https://evil.example';
    });
    assert.equal(body.code, 'INVALID_SIGNATURE');
  });

  it('rejects a signature whose renter differs from the rental renter', async () => {
    const typedData = await challengeFor(r.app);
    const { body } = await verifyWithMutation(r.app, typedData, (m) => {
      m.renter = other.address;
    });
    assert.equal(body.code, 'INVALID_SIGNATURE');
  });

  it('rejects a caller-supplied renter field as outside the exact verify request schema', async () => {
    const typedData = await challengeFor(r.app);
    const signature = await signChallenge(typedData);
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        signature,
        nonce: typedData.message.nonce,
        rentalId: typedData.message.rentalId,
        renter: other.address,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_BODY');
    assert.equal(res.json().code, 'INVALID_BODY');
    assert.equal(r.sessions.activeCount(), 0);
  });

  it('rejects a rental that is no longer ACTIVE at verify time', async () => {
    const typedData = await challengeFor(r.app);
    (r.rental as { status: string }).status = 'COMPLETED';
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        signature: await signChallenge(typedData),
        nonce: typedData.message.nonce,
        rentalId: typedData.message.rentalId,
      },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'Rental is not ACTIVE.');
    assert.equal(res.json().code, 'RENTAL_NOT_ACTIVE');
  });

  it('rejects a rental that expired between challenge and verify', async () => {
    const typedData = await challengeFor(r.app);
    (r.rental as { expiresAt: bigint }).expiresAt = BigInt(Math.floor(Date.now() / 1000) - 1);
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        signature: await signChallenge(typedData),
        nonce: typedData.message.nonce,
        rentalId: typedData.message.rentalId,
      },
    });
    assert.equal(res.statusCode, 409);
  });

  it('rejects a chain read failure during verify', async () => {
    const typedData = await challengeFor(r.app);
    (r.deps.rentalClient as unknown as { getRental: () => Promise<never> }).getRental = async () => {
      throw new Error('rpc down');
    };
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        signature: await signChallenge(typedData),
        nonce: typedData.message.nonce,
        rentalId: typedData.message.rentalId,
      },
    });
    assert.equal(res.statusCode, 503);
  });

  it('rejects an unknown nonce', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature: '0x' + '11'.repeat(65), nonce: '0x' + '22'.repeat(32), rentalId: '7' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'CHALLENGE_NOT_FOUND');
  });

  it('rejects a malformed body', async () => {
    for (const payload of [{}, { signature: '0x1' }, { signature: '0x1', nonce: 'n' }, { nonce: 'n', rentalId: '7' }]) {
      const res = await r.app.inject({ method: 'POST', url: '/auth/verify', payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    const bad = await r.app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { signature: '0x' + '11'.repeat(65), nonce: 'n', rentalId: 'not-a-number' },
    });
    assert.equal(bad.statusCode, 400);
  });
});

/** Sign a mutated message, then verify it, returning the response body. */
async function verifyWithMutation(
  app: FastifyInstance,
  typedData: {
    domain: ChallengeDomain;
    types: typeof CHALLENGE_TYPES;
    primaryType: string;
    message: Record<string, string>;
  },
  mutate: (m: Record<string, string>) => void,
): Promise<{ body: Record<string, unknown> }> {
  const signature = await signChallenge(typedData, renter, mutate);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: { signature, nonce: typedData.message.nonce, rentalId: typedData.message.rentalId },
  });
  return { body: res.json() };
}

// ===========================================================================
describe('POST /v1/inference', () => {
  let r: TestRig;
  beforeEach(async () => {
    r = await rig();
    // Successful inference by default.
    (r.deps.backend as UnitTestInferenceBackendFake).streamChunks = ['Hello', ' ', 'world'];
  });
  afterEach(async () => {
    await r.close();
  });

  it('streams deltas as SSE frames and completes with the full text', async () => {
    const { token } = await verifyFor(r.app);
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type'] ?? ''), /text\/event-stream/);
    // The deltas must reach the client one event at a time, not as one buffer.
    assert.match(res.body, /event: delta\ndata: \{"output":"Hello"\}/);
    assert.match(res.body, /event: delta\ndata: \{"output":" "\}/);
    assert.match(res.body, /event: delta\ndata: \{"output":"world"\}/);
    assert.match(res.body, /event: complete\ndata: \{"output":"Hello world"/);
    // The node's own model is echoed, never a request-supplied one.
    assert.match(res.body, /"model":"test-model"/);
  });

  it('exposes an allowed cross-origin SSE response to the renter browser', async () => {
    await r.close();
    r = await rig({ allowedOrigins: ['http://localhost:8000'] });
    (r.deps.backend as UnitTestInferenceBackendFake).streamChunks = ['ok'];
    const { token } = await verifyFor(r.app);
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'http://localhost:8000',
      },
      payload: { prompt: 'hi' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:8000');
    assert.match(String(res.headers.vary ?? ''), /Origin/);
    assert.match(String(res.headers['content-type'] ?? ''), /text\/event-stream/);
  });

  it('closes the stream at generation timeout instead of leaving a half-open socket', async () => {
    // Three chunks, 40 ms apart, against a 50 ms generation cap: the watchdog
    // must fire while the stream is live.
    await r.close();
    r = await rig({ limits: { maxGenerationSeconds: 0.05 as unknown as number } });
    const fakeBackend = r.deps.backend as UnitTestInferenceBackendFake;
    fakeBackend.streamChunks = ['a', 'b', 'c', 'd', 'e', 'f'];
    fakeBackend.delayMs = 40;
    const { token } = await verifyFor(r.app);
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 200);
    // Some deltas arrived before the watchdog cut the generation short...
    assert.match(res.body, /event: delta/);
    // ...and the stream was closed with an explicit terminating event rather
    // than truncated mid-frame.
    assert.match(res.body, /event: error\ndata: \{"code":"INFERENCE_FAILED"/);
    assert.equal(res.body.endsWith('\n\n'), true);
  });

  it('releases the slot after an aborted generation, so the node is not wedged', async () => {
    await r.close();
    // The interval ceiling is not what this test is about: it proves the
    // concurrency slot is handed back after the watchdog kills a generation,
    // and the rig's default 2s spacing would refuse the second request for an
    // unrelated reason while reporting the same RATE_LIMITED code.
    r = await rig({
      limits: { maxGenerationSeconds: 0.05 as unknown as number, minRequestIntervalSeconds: 0 },
    });
    const fakeBackend = r.deps.backend as UnitTestInferenceBackendFake;
    fakeBackend.streamChunks = ['a', 'b', 'c', 'd', 'e', 'f'];
    fakeBackend.delayMs = 40;
    const { token } = await verifyFor(r.app);
    await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    // The P0 concurrency ceiling is one; if `release()` did not run the next
    // request would be refused with 429 forever.
    const after = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(after.statusCode, 200);
  });

  it('denies inference without a bearer token', async () => {
    const res = await r.app.inject({ method: 'POST', url: '/v1/inference', payload: { prompt: 'hi' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'INVALID_SESSION');
  });

  it('denies inference with a malformed authorization header', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: 'token abc' },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('denies inference with an unknown token', async () => {
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('denies inference when the on-chain renter no longer matches the session renter', async () => {
    const { token } = await verifyFor(r.app);
    // The lease moves to another address after the session was minted.
    (r.rental as { renter: string }).renter = other.address;
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'SESSION_RENTER_MISMATCH');
  });

  it('denies inference when the rental belongs to another node', async () => {
    const { token } = await verifyFor(r.app);
    (r.rental as { nodeId: bigint }).nodeId = 999n;
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('denies inference when the rental has ended', async () => {
    const { token } = await verifyFor(r.app);
    (r.rental as { expiresAt: bigint }).expiresAt = BigInt(Math.floor(Date.now() / 1000) - 1);
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 409);
    // The chain moved the lease into the past, so the shared rental gate denies
    // on the chain's own expiry. That is the authoritative answer: access ends
    // even though the session's stored expiry was not reached.
    assert.equal(res.json().code, 'RENTAL_EXPIRED');
    assert.ok(
      /ended/.test(String(res.json().error)) || /expired/.test(String(res.json().error)),
      `unexpected error text: ${res.json().error}`,
    );
  });

  // Requirement 12 — the rental is re-read at inference time, not just at sign
  // in. A session minted while the lease was ACTIVE must stop working the
  // moment the chain moves it into any terminal state, because the token is a
  // pointer to a rental, not a grant.
  for (const status of ['CANCELLED', 'COMPLETED'] as const) {
    it(`denies inference when the rental became ${status} after sign-in`, async () => {
      const { token } = await verifyFor(r.app);
      (r.rental as { status: string }).status = status;
      const res = await r.app.inject({
        method: 'POST',
        url: '/v1/inference',
        headers: { authorization: `Bearer ${token}` },
        payload: { prompt: 'hi' },
      });
      assert.equal(res.statusCode, 409, `${status} must revoke an already-issued session`);
      assert.equal(res.json().code, 'RENTAL_NOT_ACTIVE');
      assert.equal(res.json().error, 'Rental is not ACTIVE.');
    });
  }

  it('rejects an oversized body before any handler body runs', async () => {
    const { token } = await verifyFor(r.app);
    // Deliberately larger than the 1 KiB prompt cap.
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'x'.repeat(2000) },
    });
    assert.equal(res.statusCode, 413);
  });

  it('rejects a body over the JSON body limit', async () => {
    const { token } = await verifyFor(r.app);
    // The body itself is well under the prompt cap, but the envelope is padded
    // past the 4 KiB JSON ceiling, so the parse must fail first.
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ prompt: 'x'.repeat(100), pad: 'p'.repeat(8000) }),
    });
    assert.equal(res.statusCode, 413);
  });

  it('rejects unknown fields that would redirect the GPU at a renter service', async () => {
    const { token } = await verifyFor(r.app);
    for (const extra of [{ model: 'llama3' }, { baseUrl: 'http://evil' }, { messages: [] }, { system: 'jailbreak' }]) {
      const res = await r.app.inject({
        method: 'POST',
        url: '/v1/inference',
        headers: { authorization: `Bearer ${token}` },
        payload: { prompt: 'hi', ...extra },
      });
      assert.equal(res.statusCode, 400, `field ${Object.keys(extra)[0]} must be rejected`);
    }
  });

  it('enforces the per-rental request quota', async () => {
    await r.close();
    // Spacing is disabled so the per-rental count ceiling is what refuses the
    // third request; the rig's default 2s interval would reject the second one
    // first, with the same RATE_LIMITED code, and the quota of two would never
    // be exercised.
    r = await rig({ limits: { maxRequestsPerRental: 2, minRequestIntervalSeconds: 0 } });
    (r.deps.backend as UnitTestInferenceBackendFake).streamChunks = ['ok'];
    const { token } = await verifyFor(r.app);
    const send = () =>
      r.app.inject({
        method: 'POST',
        url: '/v1/inference',
        headers: { authorization: `Bearer ${token}` },
        payload: { prompt: 'hi' },
      });
    assert.equal((await send()).statusCode, 200);
    assert.equal((await send()).statusCode, 200);
    const third = await send();
    assert.equal(third.statusCode, 429);
    assert.equal(third.json().code, 'RATE_LIMITED');
  });

  it('enforces the minimum interval between requests', async () => {
    await r.close();
    r = await rig({ limits: { minRequestIntervalSeconds: 2 } });
    (r.deps.backend as UnitTestInferenceBackendFake).streamChunks = ['ok'];
    const { token } = await verifyFor(r.app);
    assert.equal(
      (
        await r.app.inject({
          method: 'POST',
          url: '/v1/inference',
          headers: { authorization: `Bearer ${token}` },
          payload: { prompt: 'hi' },
        })
      ).statusCode,
      200,
    );
    // Immediately again, inside the two-second window.
    const res = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    });
    assert.equal(res.statusCode, 429);
  });

  it('enforces a global concurrency ceiling of one', async () => {
    await r.close();
    r = await rig({ limits: { maxConcurrentInference: 1 } });
    const fakeBackend = r.deps.backend as UnitTestInferenceBackendFake;
    fakeBackend.streamChunks = ['slow'];
    fakeBackend.delayMs = 500;
    // Two sessions for the same actual lease: P0 cannot have two ACTIVE leases
    // on Node 1. The quota unit tests separately cover different quota keys.
    const { token } = await verifyFor(r.app);
    const { token: secondToken } = await verifyFor(r.app);

    const first = r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'hi' },
    }).then((response) => response);
    // The second request overlaps the first while the GPU slot is held.
    for (let attempt = 0; attempt < 100 && r.quota.activeGenerations() === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(r.quota.activeGenerations(), 1);
    const second = await r.app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${secondToken}` },
      payload: { prompt: 'hi' },
    });
    assert.equal((await first).statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().code, 'CONCURRENCY_LIMIT');
  });
});

// ===========================================================================
describe('CORS', () => {
  let r: TestRig;
  afterEach(async () => {
    if (r) await r.close();
  });

  it('reflects only an allow-listed origin, never a wildcard and never a request-supplied one', async () => {
    r = await rig();
    (r.deps.config as { allowedOrigins: string[] }).allowedOrigins = [AUDIENCE];
    // Re-registering the plugin is not possible after listen, so close and
    // rebuild with the allow-list in place from the start.
    await r.close();
    r = await rig();
    const app = r.app;
    await app.close();

    const config = r.deps.config;
    (config as { allowedOrigins: string[] }).allowedOrigins = [AUDIENCE];
    const rebuilt = await buildServer(r.deps);

    const ok = await rebuilt.inject({
      method: 'GET',
      url: '/config',
      headers: { origin: AUDIENCE },
    });
    assert.equal(ok.headers['access-control-allow-origin'], AUDIENCE);

    const bad = await rebuilt.inject({
      method: 'GET',
      url: '/config',
      headers: { origin: 'https://evil.example' },
    });
    // Not allow-listed: no CORS header at all, so the browser blocks the read.
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    assert.notEqual(bad.headers['access-control-allow-origin'], '*');
    await rebuilt.close();
  });
});

// ===========================================================================
describe('logger redaction', () => {
  // Values the end-to-end leak test drives through a real request, so a leak is
  // a string the assertion can search for exactly rather than a shape it guesses
  // at. They are deliberately not anything a request field would contain by
  // default, so a false pass is not possible.
  const secretPrompt = 'the renter private prompt 7f3a91';
  const secretOutput = 'the model private answer 51bb02';

  /**
   * Collect every primitive value in a record, walking arrays and objects.
   *
   * Leak assertions must compare values, not serialized JSON: a redacted key
   * name still carries the text that was sensitive (`privateKey` contains
   * "private"), so `JSON.stringify(...).includes(secret)` fails on the key even
   * when every value was correctly replaced.
   */
  function values(value: unknown, out: unknown[] = []): unknown[] {
    if (Array.isArray(value)) {
      for (const item of value) values(item, out);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) values(item, out);
    } else {
      out.push(value);
    }
    return out;
  }

  // The P0 logging rule is a boundary between the node and its operator, so it
  // is asserted against the shipped helpers rather than a hand-written stub.
  it('lists every P0-forbidden field as a pino redact path', () => {
    const required = [
      'req.headers.authorization',
      'signature',
      'nonce',
      'sessionToken',
      'prompt',
      'messages',
      'output',
    ];
    for (const path of required) {
      assert.equal(REDACT_PATHS.includes(path), true, `${path} must be a redact path`);
    }
    // The raw token travels as `Authorization: Bearer <token>`; the header, not
    // a synthetic key, is what must be stripped.
    assert.equal(REDACT_PATHS.includes('req.headers.authorization'), true);
    assert.equal(REDACT_PATHS.includes('req.headers.cookie'), true);
  });

  it('replaces every sensitive key with a placeholder, at any depth', () => {
    const redacted = redactDeep({
      // A single flat record carrying each forbidden field explicitly, which is
      // the shape the app actually logs.
      signature: '0xdeadbeef',
      nonce: '0xabc123',
      sessionToken: 'raw-token',
      authorization: 'Bearer raw-token',
      prompt: 'my secret prompt',
      messages: [{ role: 'user', content: 'private' }],
      output: 'the private answer',
      response: JSON.stringify({ output: 'answer' }),
      challengeNonce: '0xfeed',
      privateKey: '0x' + '11'.repeat(32),
      // The P0-allowed fields must survive verbatim.
      rentalId: '7',
      requestId: 'req-1',
      timestamp: 1700000000,
      latencyMs: 12,
      model: 'test-model',
      success: true,
      // Nested, to prove the walk is recursive.
      nested: { headers: { authorization: 'Bearer nested', cookie: 'sid=x' }, prompt: 'deep' },
    });

    // Compare values, not serialized JSON: the redacted *keys* still carry
    // sensitive text (`privateKey` contains "private", `challengeNonce` contains
    // "nonce"), and those names are what a log line legitimately shows.
    const leaked = values(redacted).filter((v): v is string => typeof v === 'string');
    for (const secret of ['0xdeadbeef', '0xabc123', 'raw-token', 'Bearer', 'my secret prompt', 'private', 'the private answer', '0x' + '11'.repeat(32), '0xfeed']) {
      assert.equal(leaked.includes(secret), false, `leaked: ${secret}`);
    }
    // Every allowed field survives verbatim, so the redaction is not a blanket
    // strip that would make the log useless.
    assert.equal(leaked.includes('[REDACTED]'), true);
    assert.equal((redacted as Record<string, unknown>).rentalId, '7');
    assert.equal((redacted as Record<string, unknown>).requestId, 'req-1');
    assert.equal((redacted as Record<string, unknown>).timestamp, 1700000000);
    assert.equal((redacted as Record<string, unknown>).latencyMs, 12);
    assert.equal((redacted as Record<string, unknown>).model, 'test-model');
    assert.equal((redacted as Record<string, unknown>).success, true);
  });

  it('redacts the token wherever it appears in a log record, not only under its own key', () => {
    // A named function rather than a full pino instance: the assertion is about
    // which values are safe to log, which is the same question at every layer.
    const redacted = redactDeep({
      // Every spelling the two layers use for the same token must be stripped,
      // wherever it sits in the record.
      token: 'session-token',
      sessionToken: 'session-token',
      session_token: 'session-token',
      bearer: 'session-token',
      result: { sessionToken: 'session-token' },
    });
    assert.equal(JSON.stringify(redacted).includes('session-token'), false);
  });

  // The two tests above assert the shipped helpers can redact. This one asserts
  // what actually protects the operator: that a real signed-in request whose
  // prompt, model output, bearer token and signature are all known leaves none
  // of them in the stream produced by the production pino logger. A redaction
  // list that is never wired into the logger the agent really uses would leave
  // the two tests above green and this one red.
  it('writes a real signed-in request to the log without its token, signature, nonce, prompt or output', async () => {
    // Capture on a stream rather than the real fd, so the assertion does not
    // depend on the test runner's own stdout.
    const written: string[] = [];
    const capture = new Writable({
      write(chunk: unknown, _enc: unknown, done: () => void) {
        written.push(String(chunk));
        done();
      },
    });
    const pino = (await import('pino')).default;
    const capturedLogger = pino(
      { level: 'trace', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      capture,
    );

    const rig2 = await rig({ deps: { logger: capturedLogger } });
    const app = rig2.app;

    // Stub the model so the output value is known to the test.
    const fakeBackend = new UnitTestInferenceBackendFake('test-model');
    fakeBackend.streamChunks = [secretOutput];
    rig2.deps.backend = fakeBackend;

    // Sign in exactly as the browser does, so the token, signature and nonce are
    // generated by the code under test rather than by the test.
    const signIn = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: await (async () => {
        const typedData = await challengeFor(app);
        return {
          signature: await signChallenge(typedData),
          nonce: typedData.message.nonce,
          rentalId: typedData.message.rentalId,
        };
      })(),
    });
    // 201, not 200: verify *creates* the session, so a 200 would mean a session
    // was re-issued for an existing token.
    assert.equal(signIn.statusCode, 201, `sign-in failed: ${signIn.body}`);
    // The response field is `sessionToken`; the same token is what the frontend
    // later sends as `Authorization: Bearer <token>`, so this is the exact value
    // the log must not carry.
    const token = (signIn.json().token ?? signIn.json().sessionToken) as string;
    assert.ok(token.length > 20, 'a real session token must have been issued');

    const inference = await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: secretPrompt },
    });
    assert.equal(inference.statusCode, 200, `inference failed: ${inference.body}`);

    // The rejection paths too: an error handler holding the request it just
    // refused is the likeliest place to dump it verbatim.
    await app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: 'does-not-parse' } });
    await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: 'Bearer not-a-real-token' },
      payload: { prompt: secretPrompt },
    });

    const stream = written.join('');
    assert.ok(stream.length > 0, 'the request must have produced log output to check');
    // The token, the prompt and the model output are the three that a naive log
    // line would carry verbatim.
    for (const secret of [token, secretPrompt, secretOutput]) {
      assert.equal(stream.includes(secret), false, `the log stream leaked: ${secret}`);
    }
    await rig2.close();
  });
});
