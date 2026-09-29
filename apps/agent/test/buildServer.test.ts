import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type { FastifyInstance } from 'fastify';
import { type AgentDeps, buildServer } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { SessionStore as SessionStoreImpl } from '../src/sessionStore.js';
import { ChallengeStore } from '../src/auth.js';
import { InferenceClient as InferenceClientImpl } from '../src/inference.js';
import { UnitTestInferenceBackendFake } from '../src/adapter.js';
import { HealthMonitor as HealthMonitorImpl } from '../src/health.js';
import { ReservationWatcher as ReservationWatcherImpl } from '../src/reservationWatcher.js';
import { RentalQuota as RentalQuotaImpl } from '../src/quota.js';
import { ArchcoreError, ErrorCode } from '@archcore/shared';

// ---------------------------------------------------------------------------
// Injection target: the route under test (`GET /node`) only needs
// `rentalClient.getNode`. The rest of the RentalManagerClient is unused, so a
// hand-written partial double with that one method is enough to keep the test
// self-contained and free of chain/ABI dependencies. The explicit cast is
// necessary because RentalManagerClient has a private constructor and the
// production `create()` factory is the only way to build a real instance.
// Here we want a thin double that satisfies the same shape for the single call
// exercised in this file.
// ---------------------------------------------------------------------------
const minimalRentalClient = {
  getNode: async (_nodeId: bigint) => ({ nodeId: 1n, name: 'fixture', active: true }),
  getActiveRentalForNode: async () => null,
  getRental: async () => null,
  getListing: async () => ({ nodeId: 1n, paymentToken: '0x00' as any, active: true }),
  getBlockTimestamp: async () => BigInt(Math.floor(Date.now() / 1000)),
  encodeSettleAfterExpiryCalldata: () => ({ to: '0x00' as any, data: '0x' as any, value: 0n }),
  submitTransaction: async () => '0x00' as any,
  waitForTransactionSuccess: async () => ({ status: 'success' }) as any,
  startRental: async () => '0x00' as any,
} as unknown as AgentDeps['rentalClient'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeConfig(): AgentDeps['config'] {
  // buildServer only reads `loadAgentConfig` when we do NOT inject deps. Here
  // we build the config object directly; the only fields the exercised route
  // needs are the ones returned by GET /config plus allowedOrigins for CORS.
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'error',
    allowedOrigins: [],
    audience: 'archcore://test',
    chain: {
      chainId: 46630,
      rpcUrl: 'http://127.0.0.1:19999',
      rentalManagerAddress: '0x' + 'aa'.repeat(20),
      computeAssetAddress: undefined,
    } as AgentDeps['config']['chain'],
    nodeId: 1n,
    watchIntervalMs: 1000,
    autoStartEnabled: false,
    limits: {
      maxJsonBodyBytes: 4096,
      maxPromptBytes: 1024,
      maxOutputTokens: 128,
      maxRequestsPerRental: 1,
      maxConcurrentInference: 1,
      maxGenerationSeconds: 5,
      minRequestIntervalSeconds: 1,
      challengeTtlSeconds: 60,
    },
    paymentToken: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
    paymentSymbol: 'USDG',
    interfaceVersion: '0.5',
    inferenceMode: 'demo',
    gpu: { expectedName: 'test', maxTemperatureC: 100, minFreeVramMb: 1 },
  };
}

function fakeDeps(): AgentDeps {
  // Every dependency is constructed from the fake.
  const backend = new UnitTestInferenceBackendFake('test-model');
  const config = fakeConfig();
  const logger = createLogger(config);
  const sessions = new SessionStoreImpl();
  const challenges = new ChallengeStore(60);
  const inference = new InferenceClientImpl(backend, config.limits);
  const healthMonitor = new HealthMonitorImpl(config, backend);
  const quota = new RentalQuotaImpl(config.limits);
  const watcher = new ReservationWatcherImpl(minimalRentalClient, healthMonitor, config.watchIntervalMs);
  return { config, logger, rentalClient: minimalRentalClient, backend, healthMonitor, inference, sessions, challenges, quota, watcher };
}

// ---------------------------------------------------------------------------
// buildServer with injected deps
// ---------------------------------------------------------------------------
describe('buildServer', () => {
  let deps: AgentDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    deps = fakeDeps();
    // With the eager-defaultDeps() implementation that is current as of this
    // test's creation, the call below would have already invoked
    // loadAgentConfig() and RentalManagerClient.create() before this function
    // body runs, so it would fail when RENTAL_MANAGER_ADDRESS and the ABI
    // artifact are absent. The assertions below therefore also prove that the
    // injection path does not touch defaultDeps().
    app = await buildServer(deps);
  });

  afterEach(async () => {
    if (app && typeof app.close === 'function') {
      await app.close();
    }
    // The session store timer is unref'd at construction, but calling stop()
    // clears it explicitly so node --test does not keep it active after the
    // test ends.
    deps.sessions.stop();
    // reset() leaves the watcher state deterministic in case anything
    // dereferences it after close().
    deps.watcher.reset();
  });

  it('starts with no RENTAL_MANAGER_ADDRESS and no ABI artifact', async () => {
    // If buildServer() had reached defaultDeps(), either loadAgentConfig()
    // would have thrown for the missing env or RentalManagerClient.create()
    // would have thrown for the missing ABI. Reaching here means neither was
    // touched.
    assert.ok(app);
  });

  it('GET /config returns values from the injected deps', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body as string);
    assert.strictEqual(body.chainId, 46630);
    assert.strictEqual(body.nodeId, '1');
    assert.strictEqual(body.computeAsset, '0x0000000000000000000000000000000000000000');
    assert.strictEqual(body.rentalManager, fakeConfig().chain.rentalManagerAddress);
    assert.strictEqual(body.paymentToken, '0x7E955252E15c84f5768B83c41a71F9eba181802F');
    assert.strictEqual(body.paymentSymbol, 'USDG');
    assert.strictEqual(body.agentAudience, 'archcore://test');
    assert.strictEqual(body.interfaceVersion, '0.5');
    assert.strictEqual(body.inferenceMode, 'demo');
  });

  it('GET /node uses the injected rental client double', async () => {
    const res = await app.inject({ method: 'GET', url: '/node' });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body as string);
    assert.strictEqual(body.nodeId, '1');
    assert.strictEqual(body.name, 'fixture');
    assert.strictEqual(body.active, true);
  });

  it('global handler converts an unknown dependency exception into generic INTERNAL 500', async () => {
    const server = await buildServer(fakeDeps());
    server.get('/test-unknown-error', async () => { throw Error('TEST_SECRET backend connection detail'); });
    try {
      const response = await server.inject('/test-unknown-error');
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().code, 'INTERNAL');
      assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'error']);
      assert.doesNotMatch(response.body, /TEST_SECRET|connection detail/);
    } finally { await server.close(); }
  });

  it('global handler preserves catalogue status for typed denials without raw detail', async () => {
    const server = await buildServer(fakeDeps());
    server.get('/test-typed-error', async () => { throw new ArchcoreError(ErrorCode.INVALID_SESSION, 'TEST_SECRET unsafe detail', 500); });
    try {
      const response = await server.inject('/test-typed-error');
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, 'INVALID_SESSION');
      assert.doesNotMatch(response.body, /TEST_SECRET/);
    } finally { await server.close(); }
  });
});
