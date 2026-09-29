import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { loadAgentConfig, loadEnvFile, loadRuntimeConfig, type AgentConfig } from '../src/config.js';
import { HealthMonitor } from '../src/health.js';
import { UnitTestInferenceBackendFake, BlockedInferenceBackendAdapter } from '../src/adapter.js';
import { SessionStore, digestOf } from '../src/sessionStore.js';
import { ArchcoreError, ErrorCode, CHAIN_ID } from '@archcore/shared';
import { ChallengeStore, buildDomain, typedDataPayload, randomNonce, AuthError } from '../src/auth.js';
import { InferenceClient } from '../src/inference.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    logLevel: 'info',
    allowedOrigins: ['https://localhost:3000'],
    audience: 'https://pavilion.archcore.ts.net',
    chain: {
      chainId: 46630,
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      rentalManagerAddress: '0x' + '12'.repeat(20),
      nodeId: 1n,
    },
    nodeId: 1n,
    watchIntervalMs: 1000,
    autoStartEnabled: false,
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

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------
describe('loadAgentConfig', () => {
  const originalEnv = process.env;
  // `AGENT_AUDIENCE` is a hard requirement of `loadAgentConfig`: with it absent
  // every challenge would be minted with an empty `agentAudience` and would
  // still verify, so a frontend on any origin could hold a session. Each config
  // test therefore starts from a valid audience and only the case that is
  // specifically about the audience deletes it.
  const AUDIENCE = 'https://pavilion.archcore.ts.net';

  beforeEach(() => {
    process.env = {};
    process.env.AGENT_AUDIENCE = AUDIENCE;
    process.env.INFERENCE_BACKEND_MODE = 'demo';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when INFERENCE_BACKEND_MODE is missing or not demo', () => {
    delete process.env.INFERENCE_BACKEND_MODE;
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    assert.throws(() => loadAgentConfig(process.env), /INFERENCE_BACKEND_MODE/);
    process.env.INFERENCE_BACKEND_MODE = 'production';
    assert.throws(() => loadAgentConfig(process.env), /INFERENCE_BACKEND_MODE/);
  });

  it('throws when RENTAL_MANAGER_ADDRESS is missing', () => {
    delete process.env.RENTAL_MANAGER_ADDRESS;
    assert.throws(() => loadAgentConfig(process.env), /missing required environment/);
  });

  it('returns a config with defaults when the required env is set', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    const config = loadAgentConfig(process.env);
    assert.strictEqual(config.host, '127.0.0.1');
    assert.strictEqual(config.port, 8787);
    assert.strictEqual(config.chain.chainId, 46630);
  });

  it('reads COMPUTE_ASSET_ADDRESS', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.COMPUTE_ASSET_ADDRESS = '0x' + '56'.repeat(20);
    const config = loadAgentConfig(process.env);
    assert.strictEqual(config.chain.computeAssetAddress, '0x' + '56'.repeat(20));
  });

  // The Agent does not own rental economics. Every price and deadline a renter
  // sees comes from the contract's plan catalog, read through the normalized
  // Role 2 client, so an operator cannot configure an amount or a duration that
  // disagrees with what the contract will actually charge.
  it('does not carry rental economics of its own', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    const config = loadAgentConfig(process.env) as unknown as Record<string, unknown>;
    for (const key of [
      'rentalPriceWei',
      'startGraceSeconds',
      'rentalPriceEth',
      'rentalDurationSeconds',
    ]) {
      assert.ok(!(key in config), `config must not carry ${key}`);
    }
  });

  it('ignores retired price and grace environment variables', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    // These belonged to the v0.4 one-price model, where the contract had no plan
    // catalog. They are unread now: leaving them in an operator's .env has no
    // effect rather than silently reintroducing a fixed amount.
    process.env.RENTAL_PRICE_ETH = '0.0002';
    process.env.RENTAL_PRICE_WEI = '123456789';
    process.env.START_GRACE_SECONDS = '90';
    const config = loadAgentConfig(process.env) as unknown as Record<string, unknown>;
    assert.ok(!('rentalPriceWei' in config));
    assert.ok(!('startGraceSeconds' in config));
  });

  it('parses AGENT_ALLOWED_ORIGINS as a comma-separated list', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.AGENT_ALLOWED_ORIGINS = 'https://a.example, https://b.example';
    process.env.AGENT_AUDIENCE = 'https://pavilion.archcore.ts.net';
    const config = loadAgentConfig(process.env);
    assert.deepStrictEqual(config.allowedOrigins, ['https://a.example', 'https://b.example']);
  });

  // The audience is the only thing that binds a signed challenge to this
  // deployment's origin, and it is compared by exact equality on both sides of
  // the wire. A value that is not exactly one origin either mints a challenge
  // no honest frontend can reproduce, or — in the wildcard case — accepts
  // every origin at once.
  describe('AGENT_AUDIENCE must be exactly one origin', () => {
    beforeEach(() => {
      process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
      process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    });

    const accepted: Array<[string, string]> = [
      ['the production https origin', 'https://pavilion.archcore.ts.net'],
      ['an https origin on a non-default port', 'https://pavilion.archcore.ts.net:8443'],
      ['a tradename-free tailnet host', 'https://archcore.example.ts.net'],
      ['the loopback v4 origin', 'http://127.0.0.1:5173'],
      ['the loopback name', 'http://localhost:5173'],
      ['the loopback v6 origin', 'http://[::1]:5173'],
    ];

    for (const [label, value] of accepted) {
      it(`accepts ${label}`, () => {
        process.env.AGENT_AUDIENCE = value;
        assert.strictEqual(loadAgentConfig(process.env).audience, value);
      });
    }

    const rejected: Array<[string, string]> = [
      // A custom scheme is a URI, not an origin: the browser is never served
      // from `archcore://...`, so a challenge minted with it cannot be signed
      // by anything a real frontend produces.
      ['a non-http(s) scheme', 'archcore://pavilion.archcore.ts.net'],
      ['ftp', 'ftp://pavilion.archcore.ts.net'],
      // Wildcards: every origin at once.
      ['a wildcard host label', 'https://*.archcore.ts.net'],
      ['a wildcard with no scheme', '*.archcore.ts.net'],
      // Anything that is not a bare `scheme://host[:port]`.
      ['a trailing path', 'https://pavilion.archcore.ts.net/app'],
      ['a trailing slash and path', 'https://pavilion.archcore.ts.net/'],
      ['a query string', 'https://pavilion.archcore.ts.net?x=1'],
      ['a fragment', 'https://pavilion.archcore.ts.net#frag'],
      ['embedded credentials', 'https://user:pw@pavilion.archcore.ts.net'],
      ['a bare hostname', 'pavilion.archcore.ts.net'],
      ['plain http on a public host', 'http://pavilion.archcore.ts.net'],
    ];

    for (const [label, value] of rejected) {
      it(`rejects ${label}`, () => {
        process.env.AGENT_AUDIENCE = value;
        assert.throws(() => loadAgentConfig(process.env), /AGENT_AUDIENCE must be exactly one origin/);
      });
    }

    // The audience must be present without AGENT_ALLOWED_ORIGINS: CORS and the
    // EIP-712 domain are two independent gates, and neither implies the other.
    it('is required even when AGENT_ALLOWED_ORIGINS is empty', () => {
      process.env.AGENT_ALLOWED_ORIGINS = '';
      delete process.env.AGENT_AUDIENCE;
      assert.throws(() => loadAgentConfig(process.env), /AGENT_AUDIENCE is required/);
    });

    // An empty value is "unset" everywhere else in this file, so it must not be
    // treated as a well-formed origin either.
    it('treats an empty AGENT_AUDIENCE as unset', () => {
      process.env.AGENT_AUDIENCE = '';
      assert.throws(() => loadAgentConfig(process.env), /AGENT_AUDIENCE is required/);
    });
  });

  // The chain id is one of the four EIP-712 domain fields and is frozen to the
  // P0 chain. A neighbouring id would be accepted only until the first
  // challenge was signed, because the frontend could never reproduce it — so it
  // is refused at start instead.
  describe('RH_CHAIN_ID is frozen', () => {
    beforeEach(() => {
      process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
      process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
      process.env.AGENT_AUDIENCE = 'https://pavilion.archcore.ts.net';
    });

    it('defaults to the frozen id', () => {
      delete process.env.RH_CHAIN_ID;
      assert.strictEqual(loadAgentConfig(process.env).chain.chainId, CHAIN_ID);
    });

    it('accepts the frozen id', () => {
      process.env.RH_CHAIN_ID = String(CHAIN_ID);
      assert.strictEqual(loadAgentConfig(process.env).chain.chainId, CHAIN_ID);
    });

    it('refuses any other id, including another valid number', () => {
      for (const bad of ['1', '46631', '421614', '0', 'abc']) {
        process.env.RH_CHAIN_ID = bad;
        assert.throws(() => loadAgentConfig(process.env), /RH_CHAIN_ID/, `RH_CHAIN_ID=${bad} must be refused`);
      }
    });
  });

  // The manager address is the EIP-712 `verifyingContract`; anything else
  // would make every recovery fail against the wrong contract.
  it('rejects a RENTAL_MANAGER_ADDRESS that is not a 20-byte address', () => {
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    for (const bad of ['not-an-address', '0x' + 'ab'.repeat(19), '0x' + 'ab'.repeat(21), '']) {
      process.env.RENTAL_MANAGER_ADDRESS = bad;
      assert.throws(() => loadAgentConfig(process.env), /RENTAL_MANAGER_ADDRESS/, `${bad} must be refused`);
    }
  });

  // A key of the wrong shape fails here, at startup, rather than surfacing on
  // the first `startRental()` the agent tries to send.
  it('rejects a PROVIDER_PRIVATE_KEY of the wrong length or shape', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    for (const bad of ['0xabc', 'ab'.repeat(32), '0x' + 'ab'.repeat(31), '0x' + 'zz'.repeat(32), '']) {
      process.env.PROVIDER_PRIVATE_KEY = bad;
      assert.throws(() => loadAgentConfig(process.env), /PROVIDER_PRIVATE_KEY/, `${bad} must be refused`);
    }
  });

  it('rejects a non-numeric or non-positive numeric override', () => {
    // Each of these runs after tests that deleted the baseline values, so the
    // whole valid set is re-established rather than inherited.
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.AGENT_AUDIENCE = 'https://pavilion.archcore.ts.net';
    delete process.env.ARCHCORE_NODE_ID;
    for (const [name, fallback] of [['AGENT_PORT', 8787], ['AGENT_WATCH_INTERVAL_MS', 5000]] as const) {
      delete process.env[name];
      assert.strictEqual(loadAgentConfig(process.env)[name === 'AGENT_PORT' ? 'port' : 'watchIntervalMs'], fallback);
      // '' is not in this list: it is "unset" everywhere else in this file, so
      // it falls through to the default rather than being rejected.
      for (const bad of ['0', '-1', '1.5', 'abc']) {
        process.env[name] = bad;
        assert.throws(() => loadAgentConfig(process.env), new RegExp(name), `${name}=${bad} must be refused`);
        // Clear before the next case, so a leftover bad AGENT_PORT does not make
        // the AGENT_WATCH_INTERVAL_MS pass below throw for the wrong reason.
        delete process.env[name];
      }
    }
  });

  it('binds to loopback unless the operator explicitly says otherwise', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.AGENT_AUDIENCE = 'https://pavilion.archcore.ts.net';
    delete process.env.AGENT_HOST;
    assert.strictEqual(loadAgentConfig(process.env).host, '127.0.0.1');
    process.env.AGENT_HOST = '   ';
    assert.strictEqual(loadAgentConfig(process.env).host, '127.0.0.1');
  });

  it('rejects a non-integer node id', () => {
    process.env.RENTAL_MANAGER_ADDRESS = '0x' + '34'.repeat(20);
    process.env.PROVIDER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.AGENT_AUDIENCE = 'https://pavilion.archcore.ts.net';
    delete process.env.ARCHCORE_NODE_ID;
    assert.strictEqual(loadAgentConfig(process.env).nodeId, 1n);
    // '' means "unset" and falls through to the default of 1n.
    for (const bad of ['-1', '1.5', 'abc']) {
      process.env.ARCHCORE_NODE_ID = bad;
      assert.throws(() => loadAgentConfig(process.env), /ARCHCORE_NODE_ID/, `${bad} must be refused`);
    }
  });

  // A `.env` next to the agent is how a node operator supplies configuration, so
  // it has to be read deterministically, and it may never override a value the
  // process environment already carries.
  describe('loadEnvFile', () => {
    const originalEnv = process.env;
    const dir = resolve(__dirname, 'fixtures', 'envfile');
    const missing = resolve(dir, 'does-not-exist.env');

    beforeEach(() => {
      process.env = {};
      process.env.AGENT_AUDIENCE = 'https://pavilion.archcore.ts.net';
    });
    afterEach(() => {
      process.env = originalEnv;
    });

    it('reads the first existing candidate and fills only absent keys', () => {
      process.env.PROVIDER_PRIVATE_KEY = '0x' + '11'.repeat(32);
      loadEnvFile([resolve(dir, 'reports.env')]);
      assert.equal(process.env.PROVIDER_PRIVATE_KEY, '0x' + '11'.repeat(32), 'the environment must win');
      assert.equal(process.env.RENTAL_MANAGER_ADDRESS, '0x' + '22'.repeat(20));
      assert.equal(process.env.AGENT_HOST, '0.0.0.0');
    });

    it('can load into an isolated target without mutating the process environment', () => {
      const target = { PROVIDER_PRIVATE_KEY: '0x' + '11'.repeat(32) };
      const before = { ...process.env };
      loadEnvFile([resolve(dir, 'reports.env')], target);
      assert.equal((target as NodeJS.ProcessEnv).RENTAL_MANAGER_ADDRESS, '0x' + '22'.repeat(20));
      assert.deepEqual(process.env, before);
    });

    it('runtime startup merges explicitly selected files without touching shell values', () => {
      const shell = {
        AGENT_AUDIENCE: 'http://localhost:8787', INFERENCE_BACKEND_MODE: 'demo',
        PROVIDER_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_HOST: '127.0.0.1',
      };
      const config = loadRuntimeConfig(shell, [resolve(dir, 'reports.env')]);
      assert.equal(config.chain.rentalManagerAddress, '0x' + '22'.repeat(20));
      assert.equal(config.host, '127.0.0.1');
      assert.equal((shell as NodeJS.ProcessEnv).RENTAL_MANAGER_ADDRESS, undefined);
    });

    it('ignores a missing file instead of throwing', () => {
      assert.doesNotThrow(() => loadEnvFile([missing]));
    });

    it('lets the environment override an empty file value', () => {
      process.env.AGENT_HOST = '10.0.0.1';
      loadEnvFile([resolve(dir, 'empty-value.env')]);
      assert.equal(process.env.AGENT_HOST, '10.0.0.1');
    });

    it('parses quoted values, comments and an export prefix', () => {
      loadEnvFile([resolve(dir, 'mixed.env')]);
      assert.equal(process.env.QUOTED_VALUE, 'a value # with a hash');
      assert.equal(process.env.SINGLE_QUOTED, 'b');
      assert.equal(process.env.EXPORTED, 'c');
      assert.equal(process.env.INLINE_COMMENT, 'd');
      assert.equal(process.env.BLANK_LINE_ABOVE, 'e');
      assert.equal(process.env.NOT_A_COMMENT, undefined);
      assert.equal(process.env['#A_LEADING_COMMENT'], undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// sessionStore.ts
//
// The raw token is returned exactly once, in `token`. The server record carries
// only its digest, so nothing named `id` exists to smuggle the credential back.
// ---------------------------------------------------------------------------
describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  afterEach(() => {
    store.stop();
  });

  it('mints a 256-bit base64url token and stores only its digest', () => {
    const { token, session } = store.create({
      rentalId: '42',
      nodeId: '1',
      renter: '0x' + 'aa'.repeat(20),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    // 32 bytes base64url = 43 chars, no padding.
    assert.strictEqual(token.length, 43);
    assert.strictEqual(/^[A-Za-z0-9_-]+$/.test(token), true);
    assert.strictEqual(session.rentalId, '42');
    assert.strictEqual(session.digest, digestOf(token));
    assert.notStrictEqual(session.digest, token);
    // The stored record must not carry the raw token anywhere.
    const record = store.recordFor(token);
    assert.deepStrictEqual(record, session);
    assert.strictEqual(JSON.stringify(record).includes(token), false);
  });

  it('resolves a live session by its raw token', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const { token, session } = store.create({
      rentalId: '42',
      nodeId: '1',
      renter: '0x' + 'aa'.repeat(20),
      expiresAt,
    });
    const got = store.get(token, Math.floor(Date.now() / 1000));
    assert.strictEqual(got.digest, session.digest);
    assert.strictEqual(got.rentalId, '42');
  });

  it('throws INVALID_SESSION for an unknown token', () => {
    assert.throws(
      () => store.get('does-not-exist', Math.floor(Date.now() / 1000)),
      (err: unknown) => err instanceof ArchcoreError && err.code === ErrorCode.INVALID_SESSION,
    );
  });

  it('throws SESSION_EXPIRED once the lease has ended', () => {
    const { token } = store.create({
      rentalId: '42',
      nodeId: '1',
      renter: '0x' + 'aa'.repeat(20),
      expiresAt: 100,
    });
    assert.throws(
      () => store.get(token, 200),
      (err: unknown) => err instanceof ArchcoreError && err.code === ErrorCode.SESSION_EXPIRED,
    );
  });

  it('removes a session by its raw token', () => {
    const { token } = store.create({
      rentalId: '42',
      nodeId: '1',
      renter: '0x' + 'aa'.repeat(20),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    store.remove(token);
    assert.throws(
      () => store.get(token, Math.floor(Date.now() / 1000)),
      (err: unknown) => err instanceof ArchcoreError && err.code === ErrorCode.INVALID_SESSION,
    );
  });
});

// ---------------------------------------------------------------------------
// auth.ts
// ---------------------------------------------------------------------------
describe('auth.ts', () => {
  describe('randomNonce', () => {
    it('returns a 0x-prefixed 64-hex string', () => {
      const nonce = randomNonce();
      assert.strictEqual(nonce.startsWith('0x'), true);
      assert.strictEqual(nonce.length, 66);
    });

    it('returns a different value on every call', () => {
      assert.notStrictEqual(randomNonce(), randomNonce());
    });
  });

  describe('buildDomain', () => {
    it('returns the EIP-712 domain pinned to this RentalManager', () => {
      const domain = buildDomain(46630, ('0x' + 'cd'.repeat(20)) as `0x${string}`);
      assert.strictEqual(domain.name, 'ComputeRWA Agent Auth');
      assert.strictEqual(domain.version, '1');
      assert.strictEqual(domain.chainId, 46630);
      assert.strictEqual(domain.verifyingContract, '0x' + 'cd'.repeat(20));
    });
  });

  describe('typedDataPayload', () => {
    it('returns an EIP-712 typed data object', () => {
      const domain = buildDomain(46630, ('0x' + 'cd'.repeat(20)) as `0x${string}`);
      const challenge = {
        nonce: randomNonce(),
        rentalId: '42',
        renter: '0x' + 'aa'.repeat(20),
        nodeId: '1',
        audience: 'https://pavilion.example.ts.net',
        issuedAt: 100,
        expiresAt: 200,
        consumed: false,
      };
      const payload = typedDataPayload(domain, challenge);
      assert.strictEqual(payload.primaryType, 'ComputeRWAAgentAuth');
      assert.deepStrictEqual(Object.keys(payload.types), ['ComputeRWAAgentAuth']);
      assert.strictEqual(payload.message.rentalId, 42n);
      assert.strictEqual(payload.message.agentAudience, challenge.audience);
    });
  });

  describe('ChallengeStore', () => {
    let store: ChallengeStore;

    beforeEach(() => {
      store = new ChallengeStore(60);
    });

    it('issues and retrieves a challenge', () => {
      const challenge = store.issue({
        rentalId: '42',
        renter: '0x' + 'aa'.repeat(20),
        nodeId: '1',
        audience: 'https://pavilion.example.ts.net',
        now: 100,
      });
      assert.strictEqual(challenge.rentalId, '42');
      assert.strictEqual(challenge.expiresAt, 160);
      assert.strictEqual(challenge.consumed, false);
    });

    it('consumes a challenge exactly once and refuses everything else', () => {
      const challenge = store.issue({
        rentalId: '42',
        renter: '0x' + 'aa'.repeat(20),
        nodeId: '1',
        audience: 'https://pavilion.example.ts.net',
        now: 100,
      });
      assert.strictEqual(store.consume(challenge.nonce, challenge.rentalId, 150), true);
      // Second use, an unknown nonce and an expired nonce all return false.
      assert.strictEqual(store.consume(challenge.nonce, challenge.rentalId, 150), false);
      assert.strictEqual(store.consume('0x' + '00'.repeat(32), '42', 150), false);
      const expired = store.issue({
        rentalId: '42',
        renter: '0x' + 'aa'.repeat(20),
        nodeId: '1',
        audience: 'https://pavilion.example.ts.net',
        now: 100,
      });
      assert.strictEqual(store.consume(expired.nonce, expired.rentalId, 170), false);
    });

    it('lookup reports unknown, replayed and expired challenges by error code', () => {
      assert.throws(
        () => store.lookup('0x' + '00'.repeat(32), '42', 150),
        (err: unknown) => err instanceof AuthError && err.code === 'CHALLENGE_NOT_FOUND',
      );
      const challenge = store.issue({
        rentalId: '42',
        renter: '0x' + 'aa'.repeat(20),
        nodeId: '1',
        audience: 'https://pavilion.example.ts.net',
        now: 100,
      });
      assert.throws(
        () => store.lookup(challenge.nonce, challenge.rentalId, 170),
        (err: unknown) => err instanceof AuthError && err.code === 'CHALLENGE_EXPIRED',
      );
      store.consume(challenge.nonce, challenge.rentalId, 150);
      assert.throws(
        () => store.lookup(challenge.nonce, challenge.rentalId, 150),
        (err: unknown) => err instanceof AuthError && err.code === 'CHALLENGE_REPLAYED',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// inference.ts
// ---------------------------------------------------------------------------
describe('InferenceClient', () => {
  let client: InferenceClient;

  beforeEach(() => {
    client = new InferenceClient(new UnitTestInferenceBackendFake('qwen2.5:3b-instruct'));
  });

  it('rejects an oversized prompt', async () => {
    const prompt = 'x'.repeat(9 * 1024);
    const signal = new AbortController().signal;
    await assert.rejects(
      () => client.generate({ model: 'qwen2.5:3b-instruct', prompt }, signal),
      /prompt is .* bytes, limit is/,
    );
  });
});

// ---------------------------------------------------------------------------
// HealthMonitor
// ---------------------------------------------------------------------------
describe('HealthMonitor', () => {
  it('reports unhealthy when backend is unreachable or blocked', async () => {
    const config = baseConfig();
    const backend = new BlockedInferenceBackendAdapter('simulated backend outage');
    const monitor = new HealthMonitor(config, backend);
    const checks = await monitor.checks();
    const backendCheck = checks.find((c: any) => c.name === 'backend');
    assert.ok(backendCheck);
    assert.strictEqual(backendCheck.status, 'unhealthy');
  });
});
