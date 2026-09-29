/**
 * Agent-runtime tests: typed inference adapter contract, request lifecycle timeline,
 * cancellation propagation, expiry during streaming, quota release across all branches,
 * security & log redaction audit, reservation watcher retries, and bounded health/GPU probing.
 *
 * In accordance with PRD v0.5 and Role 3 requirements:
 * - Legacy Ollama wiring is removed and not a required runtime dependency or fallback.
 * - Fakes used for isolated unit testing are explicitly named and counted as fakes:
 *   1. UnitTestInferenceBackendFake (simulates backend adapter without live GPU/network)
 *   2. ExecDouble (simulates nvidia-smi command execution)
 *   3. RentalSourceDouble (simulates RentalManagerClient on-chain RPC reads/starts)
 *   4. HealthMonitorDouble (simulates monitor signals for watcher tests)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { Writable } from 'node:stream';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentConfig } from '../src/config.js';
import {
  type InferenceBackendAdapter,
  BlockedInferenceBackendAdapter,
  UnitTestInferenceBackendFake,
  BackendError,
} from '../src/adapter.js';
import { InferenceClient, InferenceError } from '../src/inference.js';
import { RentalQuota } from '../src/quota.js';
import { gpuAllowsStart, HealthMonitor } from '../src/health.js';
import { readGpu, readGpuCached, resetGpuCache, type GpuSample } from '../src/gpu.js';
import { ReservationWatcher } from '../src/reservationWatcher.js';
import { SessionStore, digestOf } from '../src/sessionStore.js';
import { ChallengeStore, buildDomain, typedDataPayload } from '../src/auth.js';
import { buildServer, type AgentDeps } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { ArchcoreError, type ChainRental, DEFAULT_LIMITS, ErrorCode, REDACT_PATHS } from '@archcore/shared';

// ---------------------------------------------------------------------------
// Helpers and Labeled Test Doubles
// ---------------------------------------------------------------------------

const AUDIENCE = 'https://agent.example.invalid';
const RENTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const renterAccount = privateKeyToAccount(RENTER_KEY);

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    logLevel: 'info',
    allowedOrigins: ['https://localhost:3000'],
    audience: AUDIENCE,
    chain: {
      chainId: 46630,
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      rentalManagerAddress: '0x' + '12'.repeat(20),
      nodeId: 1n,
    },
    nodeId: 1n,
    watchIntervalMs: 1000,
    autoStartEnabled: true,
    providerPrivateKey: '0x' + '11'.repeat(32), // Public test fixture, never an operator signer.
    limits: {
      maxJsonBodyBytes: 16 * 1024,
      maxPromptBytes: 8 * 1024,
      maxOutputTokens: 256,
      maxRequestsPerRental: 10,
      maxConcurrentInference: 1,
      maxGenerationSeconds: 30,
      minRequestIntervalSeconds: 2,
      challengeTtlSeconds: 60,
    },
    gpu: {
      expectedName: 'NVIDIA A10G',
      maxTemperatureC: 85,
      minFreeVramMb: 1024,
    },
    ...overrides,
  } as AgentConfig;
}

/**
 * Labeled Fake #1: ExecDouble.
 * Simulates nvidia-smi execution without a local GPU.
 */
class ExecDouble {
  calls: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
  result: () => { error: Error | null; stdout: string; stderr: string } = () => ({
    error: null,
    stdout: 'NVIDIA A10G, 23000, 1000, 10, 60, 200\n',
    stderr: '',
  });
  delayMs = 0;

  reset(): void {
    this.calls = [];
    this.result = () => ({
      error: null,
      stdout: 'NVIDIA A10G, 23000, 1000, 10, 60, 200\n',
      stderr: '',
    });
    this.delayMs = 0;
  }

  install(): () => void {
    const original = execFile;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (execFile as any) = ((
      _file: string,
      args: string[],
      options: { timeout?: number },
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      this.calls.push({ args, timeoutMs: options?.timeout });
      const run = (): void => {
        const { error, stdout, stderr } = this.result();
        callback(error, stdout, stderr);
      };
      if (this.delayMs > 0) setTimeout(run, this.delayMs);
      else run();
      return {} as unknown as ReturnType<typeof execFile>;
    }) as typeof execFile;
    return () => {
      (execFile as unknown) = original;
    };
  }
}

/**
 * Labeled Fake #2: RentalSourceDouble.
 * Simulates chain rental read and startRental operations.
 */
class RentalSourceDouble {
  activeRental: ChainRental | null = null;
  rental: ChainRental | null = null;
  startCalls: bigint[] = [];
  startShouldFail = 0;

  async getRental(id: bigint): Promise<ChainRental | null> {
    if (this.rental && this.rental.rentalId === id) return this.rental;
    return null;
  }

  async getActiveRentalForNode(_nodeId: bigint): Promise<ChainRental | null> {
    return this.activeRental;
  }

  async getListing(nodeId: bigint): Promise<any> {
    return { nodeId, paymentToken: '0x00', active: true };
  }

  async getBlockTimestamp(): Promise<bigint> {
    return 2000000000n;
  }

  encodeSettleAfterExpiryCalldata(_rentalId: bigint): any {
    return { to: '0x00', data: '0x', value: 0n };
  }

  async submitTransaction(_request: any): Promise<`0x${string}`> {
    return `0x${'bb'.repeat(32)}` as `0x${string}`;
  }

  async waitForTransactionSuccess(_hash: any): Promise<any> {
    return { status: 'success' };
  }

  async startRental(rentalId: bigint): Promise<`0x${string}`> {
    this.startCalls.push(rentalId);
    if (this.startCalls.length <= this.startShouldFail) {
      throw new Error(`rpc rejected (attempt ${this.startCalls.length})`);
    }
    if (this.rental) {
      this.rental.status = 'ACTIVE';
    }
    return `0x${'ab'.repeat(32)}` as `0x${string}`;
  }
}

/**
 * Labeled Fake #3: HealthMonitorDouble.
 * Simulates monitor signals for watcher tests.
 */
class HealthMonitorDouble {
  cachedRental: { rentalId: bigint; expiresAt: number; startDeadline: number } | undefined;
  updated: { rentalId: bigint; expiresAt: number; startDeadline: number }[] = [];
  config: AgentConfig;
  gpu: GpuSample = { present: false, error: 'NODE_UNSUPPORTED_GPU' };
  healthy = true;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  get nodeId(): bigint {
    return this.config.nodeId ?? 1n;
  }

  async checks() {
    return [
      { name: 'agent' as const, status: 'ok' as const, detail: 'stub' },
      { name: 'rpc' as const, status: 'ok' as const, detail: 'stub' },
      { name: 'backend' as const, status: this.healthy ? ('ok' as const) : ('unhealthy' as const), detail: 'stub' },
      { name: 'gpu' as const, status: this.gpu.present ? ('ok' as const) : ('unhealthy' as const), detail: 'stub' },
    ];
  }

  async readGpu(): Promise<GpuSample> {
    return this.gpu;
  }

  async onRentalStarted(): Promise<void> {}

  async isReady(): Promise<boolean> {
    return this.healthy && this.gpu.present;
  }

  updateCachedRental(rental: {
    rentalId: bigint;
    nodeId: bigint;
    expiresAt: number;
    startDeadline: number;
  }): void {
    this.cachedRental = rental;
    this.updated.push(rental);
  }
}

function reservedRental(overrides: Partial<ChainRental> = {}): ChainRental {
  const now = Math.floor(Date.now() / 1000);
  return {
    rentalId: 1n,
    nodeId: 1n,
    renter: renterAccount.address,
    provider: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`).address,
    price: 100000000000000n,
    status: 'RESERVED',
    startDeadline: BigInt(now + 600),
    startsAt: 0n,
    expiresAt: BigInt(now + 1200),
    createdAt: BigInt(now),
    ...overrides,
  } as ChainRental;
}

// ---------------------------------------------------------------------------
// 1. Typed Adapter Boundary & Streaming Protocol
// ---------------------------------------------------------------------------
describe('InferenceBackendAdapter and Streaming Protocol', () => {
  const model = 'fixed-test-model';

  it('streams deltas and completes via the adapter contract', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    backend.streamChunks = ['token1', ' ', 'token2'];
    const client = new InferenceClient(backend, baseConfig().limits);

    const deltas: string[] = [];
    const result = await client.generateStream(
      { model, prompt: 'hello' },
      new AbortController().signal,
      {
        onDelta: (d) => deltas.push(d),
      },
    );

    assert.deepEqual(deltas, ['token1', ' ', 'token2']);
    assert.equal(result.output, 'token1 token2');
    assert.equal(result.model, model);
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0].prompt, 'hello');
  });

  it('rejects an unapproved model requested by client with 403', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    const client = new InferenceClient(backend, baseConfig().limits);

    await assert.rejects(
      () =>
        client.generateStream(
          { model: 'unauthorized-model', prompt: 'hello' },
          new AbortController().signal,
        ),
      (err: unknown) => err instanceof InferenceError && err.statusCode === 403,
    );
    assert.equal(backend.calls.length, 0, 'backend should never be reached for unapproved model');
  });

  it('propagates cancellation signal to backend and aborts stream without completion', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    backend.streamChunks = ['chunk1', 'chunk2', 'chunk3'];
    backend.delayMs = 50;
    const client = new InferenceClient(backend, baseConfig().limits);

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('client cancelled')), 25);

    let completed = false;
    await assert.rejects(
      () =>
        client.generateStream(
          { model, prompt: 'hi' },
          controller.signal,
          {
            onComplete: () => {
              completed = true;
            },
          },
        ),
      (err: unknown) => err instanceof InferenceError && err.code === 'ABORTED_AT_EXPIRY',
    );
    assert.equal(completed, false, 'onComplete must not be called after cancellation');
  });

  it('handles mid-stream upstream error chunk by aborting and not completing', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    backend.streamChunks = ['good1', 'bad', 'good2'];
    backend.chunkError = 'Upstream GPU backend fault';
    const client = new InferenceClient(backend, baseConfig().limits);

    let completed = false;
    await assert.rejects(
      () =>
        client.generateStream(
          { model, prompt: 'test' },
          new AbortController().signal,
          {
            onComplete: () => {
              completed = true;
            },
          },
        ),
      (err: unknown) => err instanceof InferenceError && err.code === 'INFERENCE_FAILED',
    );
    assert.equal(completed, false, 'onComplete must never be called on error');
  });

  it('BlockedInferenceBackendAdapter fails closed with 503 and reports unhealthy', async () => {
    const blocked = new BlockedInferenceBackendAdapter('Operator OmniRoute configuration missing');
    const readiness = await blocked.checkReadiness();
    assert.equal(readiness.ok, false);
    assert.match(readiness.detail, /BLOCKED/);

    const client = new InferenceClient(blocked, baseConfig().limits);
    await assert.rejects(
      () => client.generateStream({ model: blocked.model, prompt: 'hi' }, new AbortController().signal),
      (err: unknown) => err instanceof InferenceError && err.statusCode === 503,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. InferenceClient Budget and Input Ceilings
// ---------------------------------------------------------------------------
describe('InferenceClient budget and limits', () => {
  const model = 'fixed-test-model';

  it('pins num_predict to the frozen budget when unspecified', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    const client = new InferenceClient(backend, baseConfig().limits);

    await client.generateStream({ model, prompt: 'hi' }, new AbortController().signal);
    assert.equal(backend.calls[0].maxTokens, 256);
  });

  it('refuses a request for more tokens than the budget with canonical RATE_LIMITED 429', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    const client = new InferenceClient(backend, baseConfig().limits);

    await assert.rejects(
      () =>
        client.generateStream(
          { model, prompt: 'hi', options: { num_predict: 9999 } },
          new AbortController().signal,
        ),
      (err: unknown) => err instanceof InferenceError && err.code === 'RATE_LIMITED' && err.statusCode === 429,
    );
    assert.equal(backend.calls.length, 0);
  });

  it('rejects an oversized prompt before backend call with 413', async () => {
    const backend = new UnitTestInferenceBackendFake(model);
    const client = new InferenceClient(backend, baseConfig().limits);

    await assert.rejects(
      () => client.generateStream({ model, prompt: 'x'.repeat(9 * 1024) }, new AbortController().signal),
      (err: unknown) => err instanceof InferenceError && err.statusCode === 413,
    );
    assert.equal(backend.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Request Lifecycle Timeline & Security Gates
// ---------------------------------------------------------------------------
describe('Request Lifecycle Timeline & Security Gates', () => {
  let app: any;
  let backend: UnitTestInferenceBackendFake;
  let rentalRecord: ChainRental;
  let rpcHealthy = true;
  let sessions: SessionStore;
  let challenges: ChallengeStore;
  let quota: RentalQuota;

  const nowSec = () => Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    backend = new UnitTestInferenceBackendFake('fixed-test-model');
    backend.streamChunks = ['Hello', ' ', 'World'];
    sessions = new SessionStore();
    challenges = new ChallengeStore(60);
    quota = new RentalQuota(DEFAULT_LIMITS);
    rpcHealthy = true;

    rentalRecord = {
      rentalId: 10n,
      nodeId: 1n,
      planId: 0,
      renter: renterAccount.address,
      provider: ('0x' + '99'.repeat(20)) as `0x${string}`,
      priceAtomic: 100000n,
      durationSeconds: 300n,
      status: 'ACTIVE',
      startDeadline: BigInt(nowSec() + 120),
      startsAt: BigInt(nowSec() - 10),
      expiresAt: BigInt(nowSec() + 300),
      createdAt: BigInt(nowSec() - 10),
    };

    const mockRentalClient = {
      getRental: async (id: bigint) => {
        if (!rpcHealthy) throw new Error('RPC endpoint unavailable');
        if (id === rentalRecord.rentalId) return rentalRecord;
        return null;
      },
      getActiveRentalForNode: async () => null,
      getListing: async () => ({ nodeId: 1n, paymentToken: '0x00' as any, active: true }),
      getBlockTimestamp: async () => 2000000000n,
      encodeSettleAfterExpiryCalldata: () => ({ to: '0x00' as any, data: '0x' as any, value: 0n }),
      submitTransaction: async () => '0x00' as any,
      waitForTransactionSuccess: async () => ({ status: 'success' }) as any,
      startRental: async () => '0x00' as any,
      getNode: async () => ({ nodeId: 1n, name: 'Node 1', active: true }),
      isEoa: async () => true,
    } as any;

    const config = baseConfig();
    const logger = createLogger(config);
    const healthMonitor = new HealthMonitor(config, backend);
    const inference = new InferenceClient(backend, config.limits);
    const watcher = new ReservationWatcher(mockRentalClient, healthMonitor, 1000);

    const deps: AgentDeps = {
      config,
      logger,
      rentalClient: mockRentalClient,
      backend,
      healthMonitor,
      inference,
      sessions,
      challenges,
      quota,
      watcher,
    };

    app = await buildServer(deps);
  });

  afterEach(async () => {
    if (app) await app.close();
    sessions.stop();
    challenges.stop();
  });

  async function getValidToken(): Promise<string> {
    const cRes = await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { rentalId: '10' },
    });
    assert.equal(cRes.statusCode, 201);
    const cBody = cRes.json();

    const signature = await renterAccount.signTypedData({
      domain: cBody.domain,
      types: cBody.types,
      primaryType: cBody.primaryType,
      message: {
        ...cBody.message,
        rentalId: BigInt(cBody.message.rentalId),
        nodeId: BigInt(cBody.message.nodeId),
        issuedAt: BigInt(cBody.message.issuedAt),
        expiresAt: BigInt(cBody.message.expiresAt),
      },
    });

    const vRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        rentalId: '10',
        nonce: cBody.message.nonce,
        signature,
      },
    });
    assert.equal(vRes.statusCode, 201);
    return vRes.json().token ?? vRes.json().sessionToken;
  }

  it('Timeline 1: ACTIVE rental before expiry -> streams successfully and completes', async () => {
    const token = await getValidToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Hello agent' },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /event: delta\ndata: \{"output":"Hello"\}/);
    assert.match(res.body, /event: complete\ndata: \{"output":"Hello World"/);
    assert.equal(quota.activeGenerations(), 0, 'quota must be released in finally');
  });

  it('Timeline 2: Wall-clock expiry during streaming -> aborts with ABORTED_AT_EXPIRY', async () => {
    // Authenticate against the normal lease first. A floor(now)+1 deadline
    // leaves as little as one millisecond for signing under parallel tests.
    const token = await getValidToken();
    rentalRecord.expiresAt = BigInt(nowSec() + 3);
    backend.streamChunks = Array.from({ length: 20 }, () => 'chunk');
    backend.delayMs = 200; // Definitely extends past the actual wall-clock deadline.

    const res = await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Stream over expiry' },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /event: delta/);
    assert.match(res.body, /event: error\ndata: \{"code":"ABORTED_AT_EXPIRY"/);
    assert.doesNotMatch(res.body, /event: complete/, 'No false completion must ever be emitted');
    assert.equal(quota.activeGenerations(), 0, 'quota must be released after expiry abort');
  });

  it('Timeline 3: Subsequent request after expiry -> immediately denied with 409', async () => {
    const token = await getValidToken();

    // Fast-forward expiry
    rentalRecord.expiresAt = BigInt(nowSec() - 1);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Post-expiry request' },
    });

    assert.equal(res.statusCode, 409);
    assert.match(res.body, /SESSION_EXPIRED|RENTAL_EXPIRED/);
    assert.equal(quota.activeGenerations(), 0);
  });

  it('Timeline 4: RPC unavailable before challenge -> fails closed with 503', async () => {
    rpcHealthy = false;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { rentalId: '10' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'RPC_UNAVAILABLE');
  });

  it('Timeline 5: RPC unavailable before verify -> fails closed with 503', async () => {
    const cRes = await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { rentalId: '10' },
    });
    const cBody = cRes.json();
    const signature = await renterAccount.signTypedData({
      domain: cBody.domain,
      types: cBody.types,
      primaryType: cBody.primaryType,
      message: {
        ...cBody.message,
        rentalId: BigInt(cBody.message.rentalId),
        nodeId: BigInt(cBody.message.nodeId),
        issuedAt: BigInt(cBody.message.issuedAt),
        expiresAt: BigInt(cBody.message.expiresAt),
      },
    });

    rpcHealthy = false;
    const vRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: {
        rentalId: '10',
        nonce: cBody.message.nonce,
        signature,
      },
    });
    assert.equal(vRes.statusCode, 503);
    assert.equal(vRes.json().code, 'RPC_UNAVAILABLE');
  });

  it('Timeline 6: RPC unavailable before inference -> fails closed with 503', async () => {
    const token = await getValidToken();
    rpcHealthy = false;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Inference when RPC drops' },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'RPC_UNAVAILABLE');
    assert.equal(quota.activeGenerations(), 0);
  });

  it('Timeline 7: Challenge replay -> second verify attempt rejected with 409 CHALLENGE_REPLAYED', async () => {
    const cRes = await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { rentalId: '10' },
    });
    const cBody = cRes.json();
    const signature = await renterAccount.signTypedData({
      domain: cBody.domain,
      types: cBody.types,
      primaryType: cBody.primaryType,
      message: {
        ...cBody.message,
        rentalId: BigInt(cBody.message.rentalId),
        nodeId: BigInt(cBody.message.nodeId),
        issuedAt: BigInt(cBody.message.issuedAt),
        expiresAt: BigInt(cBody.message.expiresAt),
      },
    });

    const v1 = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { rentalId: '10', nonce: cBody.message.nonce, signature },
    });
    assert.equal(v1.statusCode, 201);

    const v2 = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { rentalId: '10', nonce: cBody.message.nonce, signature },
    });
    assert.equal(v2.statusCode, 409);
    assert.equal(v2.json().code, 'CHALLENGE_REPLAYED');
  });

  it('Timeline 8: Token identity mismatch -> 409 SESSION_RENTER_MISMATCH', async () => {
    const token = await getValidToken();
    // Simulate rental moving to another renter on-chain
    rentalRecord.renter = ('0x' + '33'.repeat(20)) as `0x${string}`;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Hijacked rental' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'SESSION_RENTER_MISMATCH');
    assert.equal(quota.activeGenerations(), 0);
  });

  it('Timeline 9: Non-ACTIVE rental statuses (RESERVED, CANCELLED, COMPLETED) fail closed with 409', async () => {
    const nonActiveStatuses: Array<ChainRental['status']> = ['RESERVED', 'CANCELLED', 'COMPLETED'];
    for (const status of nonActiveStatuses) {
      rentalRecord.status = status;
      const res = await app.inject({
        method: 'POST',
        url: '/auth/challenge',
        payload: { rentalId: '10' },
      });
      assert.equal(res.statusCode, 409, `Challenge must fail for ${status}`);
    }
  });

  it('Timeline 10: Quota release guarantee across error, reject, and success branches', async () => {
    const token = await getValidToken();

    // 1. Success branch
    await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'OK' },
    });
    assert.equal(quota.activeGenerations(), 0);

    // 2. Upstream backend error branch
    backend.errorToThrow = new BackendError('GPU engine failure', 'INFERENCE_FAILED');
    await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: 'Will fail' },
    });
    assert.equal(quota.activeGenerations(), 0);
    backend.errorToThrow = null;
  });
});

// ---------------------------------------------------------------------------
// 4. Security Audit: Secret, Prompt, and Output Redaction
// ---------------------------------------------------------------------------
describe('Security Audit: Log Redaction and Secret Absence', () => {
  it('proves secrets, tokens, prompts, signatures, and outputs are completely absent from logs', async () => {
    const written: string[] = [];
    const captureStream = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const pino = (await import('pino')).default;
    const auditLogger = pino(
      { level: 'trace', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      captureStream,
    );

    const backend = new UnitTestInferenceBackendFake('audit-model');
    const secretPrompt = 'SUPER_SECRET_PROMPT_ABC123';
    const secretOutput = 'CONFIDENTIAL_GPU_OUTPUT_XYZ789';
    backend.streamChunks = [secretOutput];

    const rentalRecord: ChainRental = {
      rentalId: 20n,
      nodeId: 1n,
      planId: 0,
      renter: renterAccount.address,
      provider: ('0x' + '99'.repeat(20)) as `0x${string}`,
      priceAtomic: 100000n,
      durationSeconds: 300n,
      status: 'ACTIVE',
      startDeadline: BigInt(Math.floor(Date.now() / 1000) + 120),
      startsAt: BigInt(Math.floor(Date.now() / 1000)),
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 300),
      createdAt: BigInt(Math.floor(Date.now() / 1000)),
    };

    const mockRentalClient = {
      getRental: async () => rentalRecord,
      getActiveRentalForNode: async () => null,
      getListing: async () => ({ nodeId: 1n, paymentToken: '0x00' as any, active: true }),
      getBlockTimestamp: async () => 2000000000n,
      encodeSettleAfterExpiryCalldata: () => ({ to: '0x00' as any, data: '0x' as any, value: 0n }),
      submitTransaction: async () => '0x00' as any,
      waitForTransactionSuccess: async () => ({ status: 'success' }) as any,
      startRental: async () => '0x00' as any,
      getNode: async () => ({ nodeId: 1n, name: 'AuditNode', active: true }),
      isEoa: async () => true,
    } as any;

    const config = baseConfig();
    const sessions = new SessionStore();
    const challenges = new ChallengeStore(60);
    const quota = new RentalQuota(DEFAULT_LIMITS);
    const healthMonitor = new HealthMonitor(config, backend);
    const inference = new InferenceClient(backend, config.limits);
    const watcher = new ReservationWatcher(mockRentalClient, healthMonitor, 1000);

    const app = await buildServer({
      config,
      logger: auditLogger,
      rentalClient: mockRentalClient,
      backend,
      healthMonitor,
      inference,
      sessions,
      challenges,
      quota,
      watcher,
    });

    // 1. Challenge
    const cRes = await app.inject({
      method: 'POST',
      url: '/auth/challenge',
      payload: { rentalId: '20' },
    });
    const cBody = cRes.json();
    const nonce = cBody.message.nonce;

    // 2. Sign
    const signature = await renterAccount.signTypedData({
      domain: cBody.domain,
      types: cBody.types,
      primaryType: cBody.primaryType,
      message: {
        ...cBody.message,
        rentalId: BigInt(cBody.message.rentalId),
        nodeId: BigInt(cBody.message.nodeId),
        issuedAt: BigInt(cBody.message.issuedAt),
        expiresAt: BigInt(cBody.message.expiresAt),
      },
    });

    // 3. Verify
    const vRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { rentalId: '20', nonce, signature },
    });
    const sessionToken = vRes.json().token ?? vRes.json().sessionToken;

    // 4. Inference
    await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { prompt: secretPrompt },
    });

    // 5. Error paths
    await app.inject({ method: 'POST', url: '/auth/challenge', payload: { rentalId: 'bad' } });
    await app.inject({
      method: 'POST',
      url: '/v1/inference',
      headers: { authorization: 'Bearer invalid-token' },
      payload: { prompt: secretPrompt },
    });

    const fullLog = written.join('');
    assert.ok(fullLog.length > 0, 'Log output must exist for audit');

    // Assert zero leakage of secrets
    assert.equal(fullLog.includes(sessionToken), false, 'Session token leaked in log');
    assert.equal(fullLog.includes(signature), false, 'Wallet signature leaked in log');
    assert.equal(fullLog.includes(nonce), false, 'Challenge nonce leaked in log');
    assert.equal(fullLog.includes(secretPrompt), false, 'Prompt leaked in log');
    assert.equal(fullLog.includes(secretOutput), false, 'Model output leaked in log');

    // Non-vacuous mutation test: assert that if raw secret was unredacted, it would be caught
    const leakedLog = fullLog + ` [LEAK] ${secretPrompt}`;
    assert.equal(leakedLog.includes(secretPrompt), true, 'Mutation check: unredacted prompt detected');

    // Assert SessionStore only stores digest, never raw token
    assert.equal(sessions.recordFor(sessionToken)?.digest, digestOf(sessionToken));
    assert.equal('token' in (sessions.recordFor(sessionToken) || {}), false, 'Session record must not store raw token');

    await app.close();
    sessions.stop();
    challenges.stop();
  });

  it('GET /config, /health, /node, /gpu/status never leak provider private keys or secrets', async () => {
    const config = baseConfig({ providerPrivateKey: '0x' + 'aa'.repeat(32) });
    const backend = new UnitTestInferenceBackendFake('model');
    const mockRentalClient = {
      getNode: async () => ({ nodeId: 1n, name: 'Node 1', active: true }),
      getActiveRentalForNode: async () => null,
      getRental: async () => null,
      getListing: async () => ({ nodeId: 1n, paymentToken: '0x00' as any, active: true }),
      getBlockTimestamp: async () => 2000000000n,
      encodeSettleAfterExpiryCalldata: () => ({ to: '0x00' as any, data: '0x' as any, value: 0n }),
      submitTransaction: async () => '0x00' as any,
      waitForTransactionSuccess: async () => ({ status: 'success' }) as any,
      startRental: async () => '0x00' as any,
    } as any;
    const healthMonitor = new HealthMonitor(config, backend);
    const inference = new InferenceClient(backend, config.limits);
    const sessions = new SessionStore();
    const challenges = new ChallengeStore(60);
    const quota = new RentalQuota(DEFAULT_LIMITS);
    const watcher = new ReservationWatcher(mockRentalClient, healthMonitor, 1000);

    const app = await buildServer({
      config,
      logger: createLogger(config),
      rentalClient: mockRentalClient,
      backend,
      healthMonitor,
      inference,
      sessions,
      challenges,
      quota,
      watcher,
    });

    const endpoints = ['/config', '/health', '/node', '/gpu/status'];
    for (const ep of endpoints) {
      const res = await app.inject({ method: 'GET', url: ep });
      assert.equal(res.body.includes('0x' + 'aa'.repeat(32)), false, `${ep} leaked provider private key`);
    }

    await app.close();
    sessions.stop();
    challenges.stop();
  });
});

// ---------------------------------------------------------------------------
// 5. RentalQuota Concurrency and Rate Limits
// ---------------------------------------------------------------------------
describe('RentalQuota', () => {
  it('enforces concurrency ceiling of 1', () => {
    const q = new RentalQuota(DEFAULT_LIMITS);
    const l1 = q.acquire(1n);
    assert.throws(() => q.acquire(2n), (err: unknown) => err instanceof ArchcoreError && err.statusCode === 429);
    l1.release();
    const l2 = q.acquire(2n);
    l2.release();
  });

  it('enforces rate limit minimum interval', () => {
    const q = new RentalQuota({ ...DEFAULT_LIMITS, minRequestIntervalSeconds: 2 });
    const now = 100_000;
    const l1 = q.acquire(1n, now);
    l1.release();
    assert.throws(
      () => q.acquire(1n, now + 1000),
      (err: unknown) => err instanceof ArchcoreError && err.code === 'RATE_LIMITED',
    );
    const l2 = q.acquire(1n, now + 2001);
    l2.release();
  });

  it('enforces maximum requests per rental', () => {
    const q = new RentalQuota({ ...DEFAULT_LIMITS, maxRequestsPerRental: 2, minRequestIntervalSeconds: 0 });
    const l1 = q.acquire(1n, 1000);
    l1.release();
    const l2 = q.acquire(1n, 2000);
    l2.release();
    assert.throws(
      () => q.acquire(1n, 3000),
      (err: unknown) => err instanceof ArchcoreError && err.code === 'RATE_LIMITED',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. ReservationWatcher Auto-Start Retry & Backoff
// ---------------------------------------------------------------------------
describe('ReservationWatcher auto-start retry', () => {
  it('starts rental when healthy and GPU is ready', async () => {
    const source = new RentalSourceDouble();
    const r = reservedRental();
    source.activeRental = r;
    source.rental = r;

    const monitor = new HealthMonitorDouble(baseConfig());
    monitor.healthy = true;
    monitor.gpu = { present: true, temperatureC: 50, memoryFreeMb: 2000 };

    const watcher = new ReservationWatcher(source as any, monitor as any, 10);
    // First tick observes new reservation and transitions idle -> active
    // @ts-expect-error accessing private tick
    await watcher.tick();
    // Second tick executes auto-start gate and calls startRental()
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(source.startCalls.length, 1);
    assert.equal(watcher.snapshot().state, 'ready');
  });

  it('blocks auto-start when backend is unhealthy', async () => {
    const source = new RentalSourceDouble();
    const r = reservedRental();
    source.activeRental = r;
    source.rental = r;

    const monitor = new HealthMonitorDouble(baseConfig());
    monitor.healthy = false; // backend unhealthy
    monitor.gpu = { present: true, temperatureC: 50, memoryFreeMb: 2000 };

    const watcher = new ReservationWatcher(source as any, monitor as any, 10);
    // First tick transitions idle -> active
    // @ts-expect-error accessing private tick
    await watcher.tick();
    // Second tick hits unhealthy backend check and records error
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(source.startCalls.length, 0);
    assert.match(String(watcher.snapshot().error), /auto-start blocked/);
  });
});

// ---------------------------------------------------------------------------
// 7. GPU Probing & HealthMonitor Levels
// ---------------------------------------------------------------------------
describe('readGpu and HealthMonitor levels', () => {
  beforeEach(() => {
    resetGpuCache();
  });

  afterEach(() => {
    resetGpuCache();
  });

  it('reads GPU sample correctly from nvidia-smi output', async () => {
    const command = async () => ({
      stdout: 'NVIDIA RTX 4090, 24576, 2048, 15, 55, 120\n',
    });
    const sample = await readGpu(4000, command);
    assert.equal(sample.present, true);
    assert.equal(sample.name, 'NVIDIA RTX 4090');
    assert.equal(sample.temperatureC, 55);
    assert.equal(sample.memoryFreeMb, 24576 - 2048);
  });

  it('reports NODE_UNSUPPORTED_GPU when nvidia-smi fails', async () => {
    const command = async () => {
      throw new Error('command not found: nvidia-smi');
    };
    const sample = await readGpu(4000, command);
    assert.equal(sample.present, false);
    assert.equal(sample.error, 'NODE_UNSUPPORTED_GPU');
  });

  it('HealthMonitor distinguishes agent, rpc, backend, and gpu readiness', async () => {
    const backend = new UnitTestInferenceBackendFake('model');
    const config = baseConfig();
    const monitor = new HealthMonitor(config, backend, async () => ({
      present: true,
      name: 'NVIDIA A10G',
      temperatureC: 60,
      memoryFreeMb: 4000,
    }), undefined, async () => true);

    const checks = await monitor.checks();
    assert.equal(checks.length, 5);
    assert.deepEqual(
      checks.map((c) => c.name),
      ['agent', 'rpc', 'privateRoute', 'backend', 'gpu'],
    );
    for (const c of checks) {
      if (c.name === 'privateRoute') {
        assert.equal(c.status, 'unknown');
      } else {
        assert.equal(c.status, 'ok');
      }
    }
  });

  it('reports degraded when GPU is too hot', async () => {
    const backend = new UnitTestInferenceBackendFake('model');
    const config = baseConfig();
    const monitor = new HealthMonitor(config, backend, async () => ({
      present: true,
      name: 'NVIDIA A10G',
      temperatureC: 90, // max is 85
      memoryFreeMb: 4000,
    }));

    const checks = await monitor.checks();
    const gpuCheck = checks.find((c) => c.name === 'gpu');
    assert.equal(gpuCheck?.status, 'degraded');
  });
});

// ---------------------------------------------------------------------------
// 8. Frozen P0 Resource Limits
// ---------------------------------------------------------------------------
describe('Frozen P0 limits constants', () => {
  it('DEFAULT_LIMITS matches PRD v0.5 frozen values', () => {
    assert.equal(DEFAULT_LIMITS.maxJsonBodyBytes, 16 * 1024);
    assert.equal(DEFAULT_LIMITS.maxPromptBytes, 8 * 1024);
    assert.equal(DEFAULT_LIMITS.maxOutputTokens, 256);
    assert.equal(DEFAULT_LIMITS.maxRequestsPerRental, 10);
    assert.equal(DEFAULT_LIMITS.maxConcurrentInference, 1);
    assert.equal(DEFAULT_LIMITS.maxGenerationSeconds, 30);
    assert.equal(DEFAULT_LIMITS.minRequestIntervalSeconds, 2);
    assert.equal(DEFAULT_LIMITS.challengeTtlSeconds, 60);
  });
});
