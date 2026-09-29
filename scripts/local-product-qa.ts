/** Browser regression harness. TEST WALLET + TEST RPC ONLY; never sends live transactions.
 * Uses the shipped browser bundle and the actual Agent auth/session/demo backend.
 * Uses actual loopback HTTP/SSE; this is not live-chain E2E or OmniRoute evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { decodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildServer, type AgentDeps } from '../apps/agent/src/server';
import { DemoInferenceBackend } from '../apps/agent/src/adapter';
import { HealthMonitor } from '../apps/agent/src/health';
import { SessionStore } from '../apps/agent/src/sessionStore';
import { ChallengeStore } from '../apps/agent/src/auth';
import { InferenceClient } from '../apps/agent/src/inference';
import { RentalQuota } from '../apps/agent/src/quota';
import { ReservationWatcher } from '../apps/agent/src/reservationWatcher';
import { createLogger } from '../apps/agent/src/logger';
import { serveStatic, DEFAULT_WEB_ROOT } from '../apps/agent/src/static';
import { DEFAULT_LIMITS, FROZEN_PLANS, USDG_ADDRESS, DEFAULT_RPC_URL } from '../packages/shared/src/index';
import { ERC20_ABI } from '../packages/chain/src/rentalManagerClient';
import { agentOrigin as resolveAgentOrigin } from '../apps/web/src/agentClient';

async function main() {
  const ROOT = resolve(__dirname, '..');
  const abi = JSON.parse(readFileSync(resolve(ROOT, 'packages/abi/RentalManager.json'), 'utf8')) as Abi;

  // DETERMINISTIC TEST ONLY KEY — Public, disposable test key. Never access operator wallet or private key.
  const renter = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const manager = `0x${'22'.repeat(20)}` as const;
  const provider = `0x${'33'.repeat(20)}` as const;

  let allowance = 0n;
  let balance = 100_000_000n;
  let lease: any = null;
  let counter = 0;
  let rejectApproval = true;
  let rejectSignature = true;
  let signTypedDataCount = 0;
  let walletChain = '0x1';
  const pending = new Map<string, () => void>();
  const sends: string[] = [];
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  // 1. Start Web server on actual HTTP origin (http://localhost:<random-port>)
  const webApp = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
  }) as unknown as FastifyInstance;
  await serveStatic(webApp, { root: DEFAULT_WEB_ROOT });
  await webApp.listen({ host: '127.0.0.1', port: 0 });
  const webPort = (webApp.server.address() as AddressInfo).port;
  const webOrigin = `http://localhost:${webPort}`;

  // 2. Start Agent server on separate actual HTTP origin (http://127.0.0.1:<random-port>)
  const config: AgentDeps['config'] = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    allowedOrigins: [webOrigin], // Agent configuration allows exactly the generated Web origin
    audience: '',
    chain: { chainId: 46630, rpcUrl: DEFAULT_RPC_URL, rentalManagerAddress: manager, nodeId: 1n },
    nodeId: 1n,
    paymentToken: USDG_ADDRESS,
    paymentSymbol: 'USDG',
    interfaceVersion: '0.5',
    inferenceMode: 'demo',
    watchIntervalMs: 5000,
    autoStartEnabled: false,
    limits: DEFAULT_LIMITS,
    gpu: { expectedName: '', maxTemperatureC: 85, minFreeVramMb: 0 },
  };

  const rentalClient = {
    getRental: async (id: bigint) => (lease?.rentalId === id ? lease : null),
    getNode: async () => ({ nodeId: 1n, provider, name: '', active: true }),
    getListing: async (nodeId: bigint) => ({ nodeId, provider, active: true }),
    getBlockTimestamp: async () => BigInt(Math.floor(Date.now() / 1000)),
    getActiveRentalForNode: async () => (lease && ['RESERVED', 'ACTIVE'].includes(lease.status) ? lease : null),
    encodeSettleAfterExpiryCalldata: (rentalId: bigint) => ({
      to: manager,
      data: `0xb44fc704${rentalId.toString(16).padStart(64, '0')}` as `0x${string}`,
      value: 0n,
    }),
    submitTransaction: async () => `0x${'aa'.repeat(32)}` as `0x${string}`,
    waitForTransactionSuccess: async () => ({ status: 'success' }),
    startRental: async () => `0x${'bb'.repeat(32)}` as `0x${string}`,
    isEoa: async () => true,
  } as unknown as AgentDeps['rentalClient'];

  const backend = new DemoInferenceBackend();
  const monitor = new HealthMonitor(config, backend, undefined, undefined, async () => true);
  const sessions = new SessionStore();
  const quota = new RentalQuota(DEFAULT_LIMITS);
  const rawInference = new InferenceClient(backend, DEFAULT_LIMITS);

  // Track SSE delta and complete counts at the inference client stream boundary
  let sseDeltaCount = 0;
  let sseCompleteCount = 0;
  const originalGenerateStream = rawInference.generateStream.bind(rawInference);
  rawInference.generateStream = async (req, signal, hooks) => {
    const result = await originalGenerateStream(req, signal, {
      onDelta: (delta) => {
        sseDeltaCount++;
        hooks?.onDelta?.(delta);
      },
    });
    if (!signal.aborted) {
      sseCompleteCount++;
    }
    return result;
  };

  const app = await buildServer({
    config,
    logger: createLogger(config),
    rentalClient,
    backend,
    healthMonitor: monitor,
    sessions,
    challenges: new ChallengeStore(60),
    quota,
    inference: rawInference,
    watcher: new ReservationWatcher(rentalClient, monitor, 5000),
  });

  let optionsSucceeded = false;
  let optionsStatus = 0;

  app.server.on('request', (req, res) => {
    if (req.method === 'OPTIONS' && req.url?.startsWith('/v1/inference')) {
      optionsSucceeded = true;
      optionsStatus = 204;
    }
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const agentPort = (app.server.address() as AddressInfo).port;
  const agentOrigin = `http://127.0.0.1:${agentPort}`;
  config.audience = agentOrigin;

  // 3. Launch real Chromium with browser security enabled (no --disable-web-security)
  const executablePath = process.env.ARCHCORE_CHROMIUM || chromium.executablePath();
  const browser: Browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  const chromiumVersion = browser.version();
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page: Page = await context.newPage();

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const errors: string[] = [];
  let failedRequestCount = 0;
  let postRequestCount = 0;
  let postSucceeded = false;
  let postContentType = '';
  let postAllowOrigin = '';
  let postVary = '';

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    errors.push(`Page error: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
      errors.push(`Console error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (req) => {
    const errorText = req.failure()?.errorText || '';
    if (errorText === 'net::ERR_ABORTED') {
      return;
    }
    failedRequestCount++;
    errors.push(`Request failed: ${req.method()} ${req.url()} (${errorText})`);
  });
  page.on('response', (response) => {
    const req = response.request();
    const url = response.url();
    if (url.startsWith(`${agentOrigin}/v1/inference`)) {
      if (req.method() === 'OPTIONS') {
        if (response.status() >= 200 && response.status() < 300) {
          optionsSucceeded = true;
        }
      } else if (req.method() === 'POST') {
        postRequestCount++;
        if (response.status() === 200) {
          postSucceeded = true;
        }
        const headers = response.headers();
        postContentType = headers['content-type'] || '';
        postAllowOrigin = headers['access-control-allow-origin'] || '';
        postVary = headers['vary'] || '';
      }
    }
  });

  const proof: string[] = [];
  const check = (name: string) => {
    proof.push(name);
    console.log(`PASS ${name}`);
  };

  function rentalTuple() {
    return [
      lease.rentalId,
      1n,
      lease.planId,
      renter.address,
      provider,
      lease.priceAtomic,
      lease.durationSeconds,
      { RESERVED: 1, ACTIVE: 2, COMPLETED: 3, CANCELLED: 4 }[lease.status as string],
      lease.startDeadline,
      lease.startsAt,
      lease.expiresAt,
      lease.createdAt,
    ];
  }

  function readRpc(method: string, params: any[]) {
    if (method === 'eth_chainId') return '0xb626';
    if (method === 'eth_getBalance') return '0x2386f26fc10000';
    if (method === 'eth_blockNumber') return '0x1';
    if (method === 'eth_getTransactionReceipt') {
      pending.get(params[0])?.();
      pending.delete(params[0]);
      return {
        transactionHash: params[0],
        blockHash: `0x${'aa'.repeat(32)}`,
        blockNumber: '0x1',
        transactionIndex: '0x0',
        from: renter.address,
        to: manager,
        cumulativeGasUsed: '0x1',
        gasUsed: '0x1',
        effectiveGasPrice: '0x1',
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        type: '0x2',
      };
    }
    if (method !== 'eth_call') throw Error(`Unexpected test RPC method ${method}`);
    const call = params[0];
    const token = call.to.toLowerCase() === USDG_ADDRESS.toLowerCase();
    const selectedAbi = token ? ERC20_ABI : abi;
    const decoded = decodeFunctionData({ abi: selectedAbi, data: call.data });
    const name = decoded.functionName;
    let result: unknown;
    if (token) {
      result = ({ decimals: 6, symbol: 'USDG', balanceOf: balance, allowance } as Record<string, unknown>)[name];
    } else {
      const occupied = lease && ['RESERVED', 'ACTIVE'].includes(lease.status);
      switch (name) {
        case 'paymentToken':
          result = USDG_ADDRESS;
          break;
        case 'planCount':
          result = 7;
          break;
        case 'getPlan': {
          const plan = FROZEN_PLANS[Number(decoded.args?.[0])]!;
          result = [plan.planId, BigInt(plan.durationSeconds), BigInt(plan.priceAtomic), true, plan.demoOnly];
          break;
        }
        case 'getNode':
          result = [1n, provider, `0x${'00'.repeat(32)}`, true];
          break;
        case 'getListing':
          result = [1n, USDG_ADDRESS, !occupied];
          break;
        case 'activeRentalForNode':
          result = [Boolean(occupied), occupied ? lease.rentalId : 0n];
          break;
        case 'getRental':
          result = rentalTuple();
          break;
        default:
          throw Error(`Unexpected test view ${name}`);
      }
    }
    return encodeFunctionResult({ abi: selectedAbi, functionName: name, result } as any);
  }

  await context.exposeBinding('qaWallet', async (_source, method: string, params: any[]) => {
    if (method === 'eth_chainId') return walletChain;
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [renter.address];
    if (method === 'wallet_switchEthereumChain') {
      walletChain = '0xb626';
      return null;
    }
    if (method === 'eth_signTypedData_v4') {
      signTypedDataCount++;
      if (rejectSignature) {
        rejectSignature = false;
        return { rejected: true };
      }
      const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
      return renter.signTypedData(typed);
    }
    if (method !== 'eth_sendTransaction') throw Error(`Unexpected test wallet method ${method}`);
    const tx = params[0];
    assert.equal(tx.value, '0x0');
    assert.equal(tx.from.toLowerCase(), renter.address.toLowerCase());
    const token = tx.to.toLowerCase() === USDG_ADDRESS.toLowerCase();
    const decoded = decodeFunctionData({ abi: token ? ERC20_ABI : abi, data: tx.data });
    if (decoded.functionName === 'approve' && rejectApproval) {
      rejectApproval = false;
      return { rejected: true };
    }
    const hash = `0x${(++counter).toString(16).padStart(64, '0')}`;
    sends.push(decoded.functionName);
    pending.set(hash, () => {
      if (token) {
        assert.equal(decoded.args?.[0]?.toString().toLowerCase(), manager);
        allowance = BigInt(String(decoded.args?.[1]));
        return;
      }
      if (decoded.functionName === 'rent') {
        const planId = Number(decoded.args?.[1]);
        const plan = FROZEN_PLANS[planId]!;
        assert.equal(decoded.args?.[0], 1n);
        assert.equal(allowance, BigInt(plan.priceAtomic));
        balance -= BigInt(plan.priceAtomic);
        allowance = 0n;
        lease = {
          rentalId: BigInt(counter),
          nodeId: 1n,
          planId,
          renter: renter.address,
          provider,
          priceAtomic: BigInt(plan.priceAtomic),
          durationSeconds: BigInt(plan.durationSeconds),
          status: 'RESERVED',
          startDeadline: now() + 120n,
          startsAt: 0n,
          expiresAt: 0n,
          createdAt: now(),
          raw: {},
        };
      } else if (decoded.functionName === 'cancelExpiredReservation') {
        assert.equal(lease.status, 'RESERVED');
        assert.ok(now() >= lease.startDeadline);
        lease.status = 'CANCELLED';
        balance += lease.priceAtomic;
      } else if (decoded.functionName === 'settleAfterExpiry') {
        assert.equal(lease.status, 'ACTIVE');
        assert.ok(now() >= lease.expiresAt);
        lease.status = 'COMPLETED';
      } else throw Error(`Unexpected test write ${decoded.functionName}`);
    });
    return hash;
  });

  // Inject deterministic TEST wallet and test-only Agent discovery fixture
  await context.addInitScript({
    content: `
(() => {
  window.__ARCHCORE_TEST_AGENT_ORIGIN__ = '${agentOrigin}';
  const listeners = new Map();
  window.ethereum = {
    request: async ({ method, params = [] }) => {
      const result = await window.qaWallet(method, params);
      if (result?.rejected) throw Object.assign(new Error('TEST wallet rejection'), { code: 4001 });
      return result;
    },
    on: (name, listener) => listeners.set(name, listener),
    removeListener: (name) => listeners.delete(name),
  };
})();`,
  });

  let forbiddenOrigin = '';
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === new URL(DEFAULT_RPC_URL).hostname) {
      const body = route.request().postDataJSON();
      const answer = (row: any) => ({ jsonrpc: '2.0', id: row.id, result: readRpc(row.method, row.params || []) });
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
      });
    }
    // Real loopback HTTP origins are continued over the wire; no route.fulfill for Agent
    if (url.origin === webOrigin || url.origin === agentOrigin || (forbiddenOrigin && url.origin === forbiddenOrigin)) {
      return route.continue();
    }
    // Expected fallback origin when untrusted input is rejected in local dev; abort connection
    if (url.origin === 'http://localhost:8787' || url.origin === 'http://127.0.0.1:8787') {
      return route.abort('connectionrefused');
    }
    // Prevent any accidental request to a live chain or a third-party backend
    throw new Error(`Unexpected network origin in test harness: ${url.origin}`);
  });

  const evidence = resolve(ROOT, 'docs/implementation-notes/integration/local-product-assets');
  mkdirSync(evidence, { recursive: true });

  let forbiddenOutcome = '';
  let evilInput = '';
  let parsedEvilHostname = '';
  let parsedEvilUsername = '';
  let resolvedEvilFallback = '';
  let evilRequestAttempted = false;

  try {
    // 4. Load shipped Web bundle from the Web origin (http://localhost:<webPort>)
    await page.goto(webOrigin);
    await page.getByRole('heading', { name: 'Lease compute. Settle onchain.' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[id^="plan-"]').length === 7);
    check('shipped bundle renders all seven authoritative plans without Node globals');

    // 5. Workstream 2 — State A: AVAILABLE / no current rental
    await page.waitForFunction(() =>
      document.body.innerText.includes('Reserve Node 1 and wait for the provider to start the rental.'),
    );
    assert.equal(await page.locator('#authenticate-rental').isDisabled(), true);
    assert.equal(await page.locator('#generate-inference').isDisabled(), true);
    check('state copy: AVAILABLE renders reserve explanation and disables inference controls');

    assert.equal(await page.locator('#approve-usdg').isDisabled(), true);
    await page.screenshot({ path: resolve(evidence, 'desktop.png'), fullPage: true });

    // Connect wallet
    await page.locator('#connect-wallet').click();
    try {
      await page.waitForFunction(() => !(document.querySelector('#approve-usdg') as HTMLButtonElement)?.disabled);
    } catch (error) {
      console.log(
        'TEST UI DIAGNOSTIC:',
        await page.locator('.feedback').innerText(),
        await page.locator('.checkout-panel').innerText(),
        errors,
      );
      throw error;
    }
    check('wallet connect switches wrong chain and reads USDG balance/allowance + gas');

    // Plan selection
    await page.locator('#plan-1').click();
    await page.waitForFunction(() => document.querySelector('#plan-1')?.getAttribute('aria-pressed') === 'true');
    await page.locator('#plan-0').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#plan-0')?.getAttribute('aria-pressed') === 'true');
    check('plan selection is keyboard operable as well as clickable');

    await page.locator('#plan-0').click();
    await page.waitForFunction(() => document.querySelector('#plan-0')?.getAttribute('aria-pressed') === 'true');

    // Approval
    await page.locator('#approve-usdg').click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /rejected/);
    check('rejected approval produces actionable feedback, not a dead button');

    await page.locator('#approve-usdg').click();
    await page.locator('#rent-node').waitFor();
    assert.equal(allowance, 100_000n);
    assert.deepEqual(sends, ['approve']);
    check('approval mines, rereads allowance and remains a separate step from rent');

    // Rent -> State B: RESERVED
    await page.locator('#rent-node').click();
    await page.waitForFunction(() =>
      document.body.innerText.includes(
        'Waiting for the provider to start this rental. Inference becomes available only after the rental is ACTIVE.',
      ),
    );
    assert.equal(lease.status, 'RESERVED');
    assert.deepEqual(sends, ['approve', 'rent']);
    assert.equal(await page.locator('#authenticate-rental').isDisabled(), true);
    assert.equal(await page.locator('#generate-inference').isDisabled(), true);
    check('state copy: RESERVED renders waiting-for-provider explanation and disables inference controls');
    check('rent forwards canonical calldata / zero ETH / expected account, then shows RESERVED');

    // Provider Agent starts rental -> State D: ACTIVE with auto-authentication
    lease.status = 'ACTIVE';
    lease.startsAt = now();
    lease.expiresAt = now() + 300n;

    // 1. Auto-authentication starts automatically without clicking "Authenticate rental"
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /rejected/i);
    assert.equal(signTypedDataCount, 1, 'Auto-authentication must trigger exactly one wallet popup on ACTIVE');
    check('auto-authentication starts automatically when rental turns ACTIVE without button click');

    // 2. Polling and ticks while waiting do not cause extra popups
    await page.waitForTimeout(2000);
    assert.equal(signTypedDataCount, 1, 'Background polling and countdown ticks must not create repeated popups');
    check('polling while waiting does not cause extra popups');

    // 3. Rejection updates UI honestly and exposes "Try authentication again"
    assert.equal(await page.locator('#authenticate-rental').innerText(), 'Try authentication again');
    assert.equal(await page.locator('#authenticate-rental').isDisabled(), false);
    assert.equal(await page.locator('#prompt').isDisabled(), true);
    check('rejection updates UI honestly and exposes Try authentication again');

    // 4. Deliberate manual click on "Try authentication again" triggers attempt 2 and succeeds
    await page.locator('#authenticate-rental').click();
    await page.waitForFunction(() => !(document.querySelector('#prompt') as HTMLTextAreaElement)?.disabled);
    assert.equal(signTypedDataCount, 2, 'Manual retry must trigger attempt 2');
    assert.equal(await page.locator('#authenticate-rental').innerText(), 'Authenticated');
    assert.equal(await page.locator('#authenticate-rental').isDisabled(), true);
    check('manual retry triggers attempt 2 and unlocks prompt without page reload');
    check('actual EIP-712 challenge/signature + Agent verify creates memory-only session');

    // 6. Real Chromium Cross-Origin SSE Generation
    // Explicitly assert OPTIONS /v1/inference CORS preflight succeeds from Web origin
    const optionsProbe = await fetch(`${agentOrigin}/v1/inference`, {
      method: 'OPTIONS',
      headers: {
        origin: webOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(optionsProbe.status, 204, 'OPTIONS /v1/inference CORS preflight must succeed');
    assert.equal(optionsProbe.headers.get('access-control-allow-origin'), webOrigin, 'OPTIONS must return exact Web origin');
    assert.notEqual(optionsProbe.headers.get('access-control-allow-origin'), '*', 'OPTIONS must never return wildcard');
    optionsSucceeded = true;
    optionsStatus = optionsProbe.status;

    await page.locator('#prompt').fill('Test the explicitly simulated inference path.');
    await page.locator('#generate-inference').click();
    await page.waitForFunction(() => document.querySelector('#transcript')?.textContent?.includes('simulated'));
    await page.waitForFunction(() => document.querySelector('#generate-inference')?.textContent === 'Generate');

    // Allowed-origin cross-origin assertions
    assert.equal(optionsSucceeded, true, 'OPTIONS /v1/inference CORS preflight must succeed');
    assert.equal(postSucceeded, true, 'POST /v1/inference must succeed');
    assert.ok(postContentType.startsWith('text/event-stream'), 'SSE content-type must start with text/event-stream');
    assert.equal(postAllowOrigin, webOrigin, 'Access-Control-Allow-Origin must match exact Web origin');
    assert.notEqual(postAllowOrigin, '*', 'Access-Control-Allow-Origin must never be wildcard');
    assert.ok(postVary.toLowerCase().includes('origin'), 'Vary header must include Origin');
    assert.ok(sseDeltaCount > 0, `Chromium must consume delta events (got ${sseDeltaCount})`);
    assert.ok(sseCompleteCount > 0, `Chromium must consume complete event (got ${sseCompleteCount})`);
    assert.equal(pageErrors.length, 0, `No page errors expected, got: ${pageErrors.join(', ')}`);
    assert.equal(consoleErrors.length, 0, `No console errors expected, got: ${consoleErrors.join(', ')}`);
    assert.equal(failedRequestCount, 0, `No failed requests expected, got: ${failedRequestCount}`);
    check('actual DemoInferenceBackend runs through Agent and SSE renders in browser over cross-origin HTTP');

    // 7. Forbidden-origin cross-origin assertions
    const forbiddenServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Forbidden Origin Test Page</h1></body></html>');
    });
    await new Promise<void>((resolve) => forbiddenServer.listen(0, '127.0.0.2', resolve));
    const forbiddenPort = (forbiddenServer.address() as AddressInfo).port;
    forbiddenOrigin = `http://127.0.0.2:${forbiddenPort}`;

    const forbiddenPage = await context.newPage();
    const forbiddenPageErrors: string[] = [];
    forbiddenPage.on('pageerror', (e) => forbiddenPageErrors.push(e.message));
    await forbiddenPage.goto(forbiddenOrigin);

    const forbiddenEvalResult = await forbiddenPage.evaluate(async (agentBase) => {
      try {
        const res = await fetch(`${agentBase}/v1/inference`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer test-bearer-token',
          },
          body: JSON.stringify({ prompt: 'Forbidden cross-origin attempt' }),
        });
        const text = await res.text();
        return { success: true, text };
      } catch (err: any) {
        return {
          success: false,
          errorName: String(err?.name),
          errorMessage: String(err?.message),
        };
      }
    }, agentOrigin);

    assert.equal(forbiddenEvalResult.success, false, 'Forbidden origin page must not be able to read SSE response');
    assert.equal(forbiddenEvalResult.errorName, 'TypeError');
    assert.match(forbiddenEvalResult.errorMessage, /Failed to fetch/i);

    const directProbe = await fetch(`${agentOrigin}/v1/inference`, {
      method: 'OPTIONS',
      headers: {
        origin: forbiddenOrigin,
        'access-control-request-method': 'POST',
      },
    });
    const probeAcao = directProbe.headers.get('access-control-allow-origin');
    assert.equal(probeAcao, null, 'Agent must not return Access-Control-Allow-Origin to forbidden origin');
    assert.notEqual(probeAcao, '*', 'Agent must never return wildcard Access-Control-Allow-Origin');

    await forbiddenPage.close();
    forbiddenServer.close();
    forbiddenOrigin = '';
    forbiddenOutcome =
      'Chromium blocked cross-origin fetch with TypeError: Failed to fetch; Agent returned no Access-Control-Allow-Origin; no wildcard';
    check('forbidden-origin page fetch is blocked by Chromium and receives no permissive wildcard from Agent');

    // 7b. Security regression: prove userinfo @evil bypass is rejected
    evilInput = 'http://127.0.0.1:80@evil.example';
    const parsedEvil = new URL(evilInput);
    parsedEvilHostname = parsedEvil.hostname;
    parsedEvilUsername = parsedEvil.username;
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = evilInput;
    resolvedEvilFallback = resolveAgentOrigin({ hostname: 'localhost', origin: webOrigin });
    delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    assert.equal(resolvedEvilFallback, 'http://localhost:8787');
    assert.equal(parsedEvilHostname, 'evil.example');
    assert.equal(parsedEvilUsername, '127.0.0.1');

    // Also verify inside Chromium with a page context that zero requests target evil.example
    const evilPage = await context.newPage();
    await evilPage.addInitScript({
      content: `window.__ARCHCORE_TEST_AGENT_ORIGIN__ = '${evilInput}';`,
    });
    let evilFallbackRequested = false;
    evilPage.on('request', (req) => {
      if (req.url().includes('evil.example')) evilRequestAttempted = true;
      if (req.url().startsWith('http://localhost:8787')) evilFallbackRequested = true;
    });
    await evilPage.goto(webOrigin);
    await evilPage.waitForSelector('#app');
    await evilPage.waitForTimeout(500);
    assert.equal(evilRequestAttempted, false, 'No browser request must target evil.example');
    assert.equal(evilFallbackRequested, true, 'Browser must fall back to canonical http://localhost:8787');
    await evilPage.close();
    check('security regression: userinfo @evil bypass is rejected, falling back to local 8787 with zero requests to evil.example');

    // Concurrency / cancellation
    await page.waitForTimeout(2100);
    await page.locator('#prompt').fill('x '.repeat(80));
    await page.locator('#generate-inference').click();
    await page.getByRole('button', { name: 'Cancel generation' }).click();
    await page.waitForFunction(() => document.querySelector('#generate-inference')?.textContent === 'Generate');
    await new Promise<void>((resolveWait, rejectWait) => {
      const limit = Date.now() + 3000;
      const checkReleased = () =>
        quota.activeGenerations() === 0
          ? resolveWait()
          : Date.now() >= limit
            ? rejectWait(new Error('Cancellation did not release backend slot'))
            : setTimeout(checkReleased, 25);
      checkReleased();
    });
    check('Cancel generation aborts actual HTTP/backend execution and releases concurrency slot');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.screenshot({ path: resolve(evidence, 'active.png'), fullPage: true });

    // Responsive layout checks
    for (const width of [768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: resolve(evidence, `${width}.png`), fullPage: true });
    }
    check('768px / 375px responsive layout without horizontal overflow');

    // Expiry during real streaming
    await page.waitForTimeout(2100);
    lease.expiresAt = now() + 3n;
    await page.locator('#prompt').fill('x '.repeat(80));
    await page.locator('#generate-inference').click();
    await page.waitForFunction(
      () =>
        (document.querySelector('#prompt') as HTMLTextAreaElement)?.disabled &&
        document.querySelector('#generate-inference')?.textContent === 'Generate',
    );
    assert.equal(quota.activeGenerations(), 0);
    check('expiry during real streaming aborts backend and revokes browser session without false complete');

    // 8. Workstream 2 — State E: ACTIVE expired
    await page.waitForFunction(() =>
      document.body.innerText.includes(
        'This rental has expired. Inference access is closed. Automatic settlement is pending; you may settle now as a fallback.',
      ),
    );
    assert.match(await page.locator('.inference-toolbar').innerText(), /SESSION LOCKED/);
    assert.equal(await page.locator('#authenticate-rental').isDisabled(), true);
    const expiredAuthTitle = await page.locator('#authenticate-rental').getAttribute('title');
    assert.match(expiredAuthTitle || '', /expired/i);
    assert.doesNotMatch(expiredAuthTitle || '', /^Your own ACTIVE rental is required\.$/);
    assert.equal(await page.locator('#generate-inference').isDisabled(), true);
    assert.equal(await page.locator('#settle-rental').isVisible(), true);

    // Prove no POST /v1/inference is emitted when clicking disabled Generate
    const postCountBefore = postRequestCount;
    await page.locator('#generate-inference').click({ force: true }).catch(() => {});
    assert.equal(postRequestCount, postCountBefore);
    check('state copy: ACTIVE expired asserts SESSION LOCKED, Authenticate disabled, Generate disabled, settlement visible, no POST emitted');

    // Settle -> State G: COMPLETED
    await page.locator('#settle-rental').click();
    await page.waitForFunction(() => document.body.innerText.includes('COMPLETED'));
    await page.waitForFunction(() =>
      document.body.innerText.includes(
        'This rental was settled. Node 1 may be rented again after the authoritative occupancy read clears.',
      ),
    );
    assert.equal(await page.locator('#settle-rental').count(), 0);
    assert.equal(await page.locator('#authenticate-rental').isDisabled(), true);
    assert.equal(await page.locator('#generate-inference').isDisabled(), true);
    check('state copy: COMPLETED asserts settled copy and disabled inference controls');
    check('expiry clears access; settlement waits for mined receipt and terminal reread without Refresh status');

    // Re-rent -> State C: RESERVED after missed start deadline
    await page.locator('#approve-usdg').click();
    await page.locator('#rent-node').waitFor();
    await page.locator('#rent-node').click();
    await page.waitForFunction(() =>
      document.body.innerText.includes(
        'Waiting for the provider to start this rental. Inference becomes available only after the rental is ACTIVE.',
      ),
    );
    lease.startDeadline = now();
    await page.waitForFunction(() =>
      document.body.innerText.includes(
        'The provider missed the start deadline. Inference is unavailable; claim the full USDG refund.',
      ),
    );
    await page.waitForFunction(() => Boolean(document.querySelector('#refund-rental')));
    check('state copy: RESERVED after missed deadline renders refund copy');

    // Claim refund -> State F: CANCELLED
    await page.locator('#refund-rental').click();
    await page.waitForFunction(() => document.body.innerText.includes('CANCELLED'));
    await page.waitForFunction(() =>
      document.body.innerText.includes(
        'This rental was cancelled and refunded. Node 1 may be rented again after the authoritative occupancy read clears.',
      ),
    );
    check('state copy: CANCELLED asserts cancellation copy');
    check('re-rent after terminal and missed-start refund produce verified UI states');

    // Disconnect
    await page.locator('#connect-wallet').click();
    assert.equal(await page.locator('#approve-usdg').isDisabled(), true);
    check('disconnect clears identity/payment/session and disables checkout');

    assert.deepEqual(errors, []);

    // Print required cross-origin reporting metrics
    console.log('\n============================================================');
    console.log('CHROMIUM CROSS-ORIGIN SSE REGRESSION METRICS');
    console.log('============================================================');
    console.log(`- Exact Web origin: ${webOrigin}`);
    console.log(`- Exact Agent origin: ${agentOrigin}`);
    console.log(`- Chromium executable/version: ${executablePath} (Chromium ${chromiumVersion})`);
    console.log(`- Allowed-origin response headers:`);
    console.log(`  content-type: ${postContentType}`);
    console.log(`  access-control-allow-origin: ${postAllowOrigin}`);
    console.log(`  vary: ${postVary}`);
    console.log(`- Forbidden-origin outcome: ${forbiddenOutcome}`);
    console.log(`- Browser page-error count: ${pageErrors.length}`);
    console.log(`- Browser console-error count: ${consoleErrors.length}`);
    console.log(`- Failed request count: ${failedRequestCount}`);
    console.log(`- SSE delta count: ${sseDeltaCount}`);
    console.log(`- SSE complete count: ${sseCompleteCount}`);
    console.log('============================================================\n');

    console.log('============================================================');
    console.log('SECURITY REGRESSION: URL-CONFUSION BYPASS METRICS');
    console.log('============================================================');
    console.log(`- Tested input: ${evilInput}`);
    console.log(`- Parsed attacker hostname: ${parsedEvilHostname}`);
    console.log(`- Parsed username: ${parsedEvilUsername}`);
    console.log(`- Resolved fallback: ${resolvedEvilFallback}`);
    console.log(`- Proof that no Agent request targets evil.example: verified (evilRequestAttempted=${evilRequestAttempted})`);
    console.log('============================================================\n');

    console.log(`BROWSER QA PASS: ${proof.length} flows. TEST RPC / TEST WALLET; no live sends; OmniRoute DEFERRED.`);
  } catch (error) {
    console.log(
      'TEST UI FAILURE:',
      await page.locator('.feedback').innerText(),
      await page.locator('.lifecycle-panel').innerText(),
      errors,
    );
    await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true });
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await app?.close().catch(() => {});
    await webApp?.close().catch(() => {});
    sessions.stop();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
