/** UI demo recorder. Uses the SHIPPED browser bundle and the real compiled Agent
 * HTTP/auth/session/SSE stack with a disposable TEST wallet and TEST RPC stub.
 * No live chain, no live keys, no live sends. Recording artifact only. */
import { readFileSync, mkdirSync, copyFileSync, statSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import { buildServer, type AgentDeps } from '../apps/agent/src/server';
import { DemoInferenceBackend } from '../apps/agent/src/adapter';
import { HealthMonitor } from '../apps/agent/src/health';
import { SessionStore } from '../apps/agent/src/sessionStore';
import { ChallengeStore } from '../apps/agent/src/auth';
import { InferenceClient } from '../apps/agent/src/inference';
import { RentalQuota } from '../apps/agent/src/quota';
import { ReservationWatcher } from '../apps/agent/src/reservationWatcher';
import { createLogger } from '../apps/agent/src/logger';
import { DEFAULT_LIMITS, FROZEN_PLANS, USDG_ADDRESS, DEFAULT_RPC_URL } from '../packages/shared/src/index';
import { ERC20_ABI } from '../packages/chain/src/rentalManagerClient';

const ROOT = resolve(import.meta.dirname, '..');
const ABI = JSON.parse(readFileSync(resolve(ROOT, 'packages/abi/RentalManager.json'), 'utf8')) as Abi;
const OUT_DIR = resolve(ROOT, 'docs/implementation-notes/integration/local-product-assets/demo');
const REHEARSE = process.argv.includes('--rehearse');
mkdirSync(OUT_DIR, { recursive: true });

// Public, disposable TEST key. Never a live/operator key.
const RENTER = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const MANAGER = `0x${'22'.repeat(20)}` as const;
const PROVIDER = `0x${'33'.repeat(20)}` as const;

let origin = 'http://127.0.0.2';
let allowance = 0n; // zero so the approval step is genuinely required and visible
let balance = 100_000_000n; // generous so the demo never stalls on a balance floor
let lease: any = null;
let counter = 0;
let firstSignatureRejected = true;
let walletChain = '0x1';
const pending = new Map<string, () => void>();
const now = () => BigInt(Math.floor(Date.now() / 1000));

const config: AgentDeps['config'] = {
  host: '127.0.0.2', port: 0, logLevel: 'silent', allowedOrigins: [], audience: origin,
  chain: { chainId: 46630, rpcUrl: DEFAULT_RPC_URL, rentalManagerAddress: MANAGER, nodeId: 1n },
  nodeId: 1n, paymentToken: USDG_ADDRESS, paymentSymbol: 'USDG', interfaceVersion: '0.5',
  inferenceMode: 'demo', watchIntervalMs: 5000, autoStartEnabled: false, limits: DEFAULT_LIMITS,
  gpu: { expectedName: '', maxTemperatureC: 85, minFreeVramMb: 0 },
};

const STATUS: Record<string, number> = { RESERVED: 1, ACTIVE: 2, COMPLETED: 3, CANCELLED: 4 };

function rentalTuple() {
  return [lease.rentalId, 1n, lease.planId, RENTER.address, PROVIDER, lease.priceAtomic,
    lease.durationSeconds, STATUS[lease.status], lease.startDeadline, lease.startsAt,
    lease.expiresAt, lease.createdAt];
}

/** Deterministic TEST-RPC stub. Mirrors the harness in scripts/local-product-qa.ts. */
function readRpc(method: string, params: any[]): unknown {
  if (method === 'eth_chainId') return '0xb626';
  if (method === 'eth_getBalance') return '0x2386f26fc10000';
  if (method === 'eth_blockNumber') return '0x1';
  if (method === 'eth_getTransactionReceipt') {
    pending.get(params[0])?.(); pending.delete(params[0]);
    return { transactionHash: params[0], blockHash: `0x${'aa'.repeat(32)}`, blockNumber: '0x1',
      transactionIndex: '0x0', from: RENTER.address, to: MANAGER, cumulativeGasUsed: '0x1', gasUsed: '0x1',
      effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2' };
  }
  if (method !== 'eth_call') throw Error(`unexpected test RPC method ${method}`);
  const call = params[0];
  const token = call.to.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const abi = token ? ERC20_ABI : ABI;
  const decoded = decodeFunctionData({ abi, data: call.data });
  const name = decoded.functionName;
  let result: unknown;
  if (token) result = ({ decimals: 6, symbol: 'USDG', balanceOf: balance, allowance } as Record<string, unknown>)[name];
  else if (name === 'planCount') result = 7;
  else if (name === 'paymentToken') result = USDG_ADDRESS;
  else if (name === 'getNode') result = [1n, PROVIDER, `0x${'00'.repeat(32)}`, true];
  else if (name === 'activeRentalForNode') {
    const live = lease && ['RESERVED', 'ACTIVE'].includes(lease.status);
    result = [Boolean(live), live ? lease.rentalId : 0n];
  } else if (name === 'getListing') result = [1n, USDG_ADDRESS, !(lease && ['RESERVED', 'ACTIVE'].includes(lease.status))];
  else if (name === 'getRental') result = rentalTuple();
  else if (name === 'getPlan') {
    const p = FROZEN_PLANS[Number(decoded.args?.[0])]!;
    result = [p.planId, BigInt(p.durationSeconds), BigInt(p.priceAtomic), true, p.demoOnly];
  } else throw Error(`unexpected test view ${name}`);
  return encodeFunctionResult({ abi, functionName: name, result } as any);
}

async function main() {
  const rehearsalTimeout = setTimeout(() => {
    console.error('Demo rehearsal / recorder timed out after bounded 120s limit');
    process.exit(1);
  }, 120_000);
  rehearsalTimeout.unref();

  let failures = 0;
  const backend = new DemoInferenceBackend();
  const sessions = new SessionStore();
  const quota = new RentalQuota(DEFAULT_LIMITS);
  const monitor = new HealthMonitor(config, backend, undefined, undefined, async () => true);
  const rentalClient = {
    getRental: async (id: bigint) => (lease?.rentalId === id ? lease : null),
    getNode: async () => ({ nodeId: 1n, provider: PROVIDER, name: '', active: true }),
    getActiveRentalForNode: async () => (lease && ['RESERVED', 'ACTIVE'].includes(lease.status) ? lease : null),
    isEoa: async () => true,
  } as unknown as AgentDeps['rentalClient'];

  let app: any = null;
  let browser: any = null;
  let context: any = null;

  try {
    app = await buildServer({
      config, logger: createLogger(config), rentalClient, backend, healthMonitor: monitor,
      sessions, challenges: new ChallengeStore(60), quota,
      inference: new InferenceClient(backend, DEFAULT_LIMITS),
      watcher: new ReservationWatcher(rentalClient, monitor, 5000),
    });
    origin = await app.listen({ host: '127.0.0.2', port: 0 });
    config.audience = origin;

    browser = await chromium.launch({
      executablePath: process.env.ARCHCORE_CHROMIUM || chromium.executablePath(),
      headless: true, args: ['--no-sandbox'],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: REHEARSE ? undefined : { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    });
  await context.exposeBinding('qaWallet', async (_s, method: string, params: any[]) => {
    if (method === 'eth_chainId') return walletChain;
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [RENTER.address];
    if (method === 'wallet_switchEthereumChain') { walletChain = '0xb626'; return null; }
    if (method === 'eth_signTypedData_v4') {
      if (firstSignatureRejected) { firstSignatureRejected = false; return { rejected: true }; }
      const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
      return RENTER.signTypedData(typed);
    }
    if (method !== 'eth_sendTransaction') throw Error(`unexpected wallet method ${method}`);
    const tx = params[0];
    const token = tx.to.toLowerCase() === USDG_ADDRESS.toLowerCase();
    const decoded = decodeFunctionData({ abi: token ? ERC20_ABI : ABI, data: tx.data });
    const hash = `0x${(++counter).toString(16).padStart(64, '0')}`;
    pending.set(hash, () => {
      if (token) { allowance = BigInt(String(decoded.args?.[1])); return; }
      if (decoded.functionName === 'rent') {
        const planId = Number(decoded.args?.[1]); const plan = FROZEN_PLANS[planId]!;
        balance -= BigInt(plan.priceAtomic); allowance = 0n;
        lease = { rentalId: BigInt(counter), nodeId: 1n, planId, renter: RENTER.address, provider: PROVIDER,
          priceAtomic: BigInt(plan.priceAtomic), durationSeconds: BigInt(plan.durationSeconds), status: 'RESERVED',
          startDeadline: now() + 600n, startsAt: 0n, expiresAt: 0n, createdAt: now(), raw: {} };
      } else if (decoded.functionName === 'startRental') {
        lease.status = 'ACTIVE'; lease.startsAt = now(); lease.expiresAt = now() + 600n;
      } else if (decoded.functionName === 'settleAfterExpiry') lease.status = 'COMPLETED';
      else throw Error(`unexpected test write ${decoded.functionName}`);
    });
    return hash;
  });
  await context.addInitScript({ content: `
(() => {
  window.ethereum = {
    request: async ({ method, params = [] }) => {
      const r = await window.qaWallet(method, params);
      if (r?.rejected) throw Object.assign(new Error('Wallet rejected the request'), { code: 4001 });
      return r;
    },
    on: () => {}, removeListener: () => {},
  };
})();` });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === new URL(DEFAULT_RPC_URL).hostname) {
      const body: any = route.request().postDataJSON();
      const answer = (row: any) => ({ jsonrpc: '2.0', id: row.id, result: readRpc(row.method, row.params || []) });
      return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
    }
    if (url.origin === origin) return route.continue();
    throw Error(`unexpected origin in demo harness: ${url.origin}`);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // ------------------------------------------------------------ overlay helpers
  async function injectOverlays() {
    await page.evaluate(() => {
      if (document.getElementById('demo-cursor')) return;
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      cursor.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 3L19 12L12 13.5L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
      cursor.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:26px;height:26px;transition:left .09s ease-out,top .09s ease-out;filter:drop-shadow(1px 1px 2px rgba(0,0,0,.45))';
      cursor.style.left = '-40px'; cursor.style.top = '-40px';
      document.body.appendChild(cursor);
      document.addEventListener('mousemove', (e) => {
        cursor.style.left = `${e.clientX - 3}px`; cursor.style.top = `${e.clientY - 2}px`;
      });
      if (document.getElementById('demo-subtitle')) return;
      const bar = document.createElement('div');
      bar.id = 'demo-subtitle';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;text-align:center;padding:13px 24px;background:rgba(8,12,10,.84);color:#eef6f1;font:500 15px/1.35 -apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.2px;opacity:0;transition:opacity .35s;pointer-events:none';
      document.body.appendChild(bar);
    });
  }
  async function show_say(text: string) {
    await page.evaluate((t) => {
      const bar = document.getElementById('demo-subtitle'); if (!bar) return;
      bar.textContent = t; bar.style.opacity = t ? '1' : '0';
    }, text);
    if (text) await page.waitForTimeout(text.length > 62 ? 2800 : 2000);
  }
  async function show(selector: string, label: string) {
    const ok = await page.locator(selector).first().isVisible().catch(() => false);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} -> ${selector}`);
    if (!ok) failures++;
    return ok;
  }
  async function moveAndClick(selector: string, label: string, after = 1400) {
    const el = page.locator(selector).first();
    if (!(await el.isVisible().catch(() => false))) { console.log(`FAIL click ${label} -> ${selector}`); failures++; return false; }
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 }); await page.waitForTimeout(430); }
    await el.click().catch((e: Error) => { console.log(`FAIL click ${label}: ${e.message}`); failures++; });
    await page.waitForTimeout(after);
    return true;
  }
  async function typeSlowly(selector: string, text: string, label: string) {
    if (!(await show(selector, `${label} (field)`))) return;
    await moveAndClick(selector, `${label} (focus)`, 420);
    await page.locator(selector).first().fill('');
    await page.locator(selector).first().pressSequentially(text, { delay: 34 });
    await page.waitForTimeout(700);
  }
  async function show_pan(selector: string, max = 5) {
    const els = await page.locator(selector).all();
    for (let i = 0; i < Math.min(els.length, max); i++) {
      const box = await els[i].boundingBox().catch(() => null);
      if (box && box.y < 700) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 9 }); await page.waitForTimeout(520); }
    }
  }
  const scrollTo = async (top: number) => {
    await page.evaluate((t) => window.scrollTo({ top: t, behavior: 'smooth' }), top);
    await page.waitForTimeout(1100);
  };
  // Rehearsal runs the identical journey with decoration suppressed, so a FAIL
  // means a real regression in the recorded path rather than a cold-state artefact.
  const say = REHEARSE ? async () => {} : show_say;
  const pan = REHEARSE ? async () => {} : show_pan;

  const journey = async () => {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await injectOverlays();
    await say('Step 1 - Agent loads its seven onchain plans');
    await page.waitForFunction(() => document.querySelectorAll('[id^="plan-"]').length === 7, null, { timeout: 15000 });
    await page.waitForTimeout(700);
    await pan('.card', 4);
    await page.waitForTimeout(500);

    await scrollTo(await page.evaluate(() => Math.round(document.body.scrollHeight * 0.28)));
    await say('Step 2 - Plans, prices and node identity come from the chain');
    await pan('[id^="plan-"]', 3);

    await scrollTo(0);
    await say('Step 3 - Connect the renter wallet');
    await moveAndClick('#connect-wallet', 'connect wallet', 2600);
    await page.waitForTimeout(700);
    await say('Step 4 - Wallet reads USDG balance and allowance');
    await pan('.asset-stats .stat, .wallet-address, .network-pill', 3);

    await scrollTo(await page.evaluate(() => Math.round(document.body.scrollHeight * 0.28)));
    await say('Step 5 - Choose the six-hour commercial plan');
    await moveAndClick('#plan-1', 'plan 1', 1500);
    await page.waitForTimeout(600);
    await pan('#plan-1, #plan-2, #plan-3', 3);

    await scrollTo(0);
    await say('Step 6 - Approve exactly the escrow amount in USDG');
    await moveAndClick('#approve-usdg', 'approve usdg', 3000);
    await page.waitForFunction(() => Boolean(document.querySelector('#rent-node')?.offsetParent), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);

    await say('Step 7 - Rent Node 1; escrow is now held onchain');
    await moveAndClick('#rent-node', 'rent node', 3200);
    await page.waitForTimeout(700);

    await say('Step 8 - The Provider Agent starts the lease');
    // The Agent owns startRental(); this flips the TEST-RPC view to ACTIVE and the
    // watcher observes it, so the UI shows the real RESERVED -> ACTIVE transition.
    await page.waitForTimeout(900);
    lease.status = 'ACTIVE'; lease.startsAt = now(); lease.expiresAt = now() + 600n;
    await moveAndClick('#refresh-status', 'refresh status', 2600);
    await page.waitForFunction(() => !(document.querySelector('#authenticate-rental') as HTMLButtonElement)?.disabled, null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(500);

    await scrollTo(0);
    await say('Step 9 - Authenticate with a signed EIP-712 challenge');
    await moveAndClick('#authenticate-rental', 'authenticate (first attempt)', 2300);
    await page.waitForFunction(() => Boolean(document.querySelector('[role="alert"]')), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
    await moveAndClick('#authenticate-rental', 'authenticate (retry)', 2600);
    await page.waitForFunction(() => !(document.querySelector('#prompt') as HTMLTextAreaElement)?.disabled, null, { timeout: 15000 }).catch(() => {});

    await scrollTo(await page.evaluate(() => Math.round(document.body.scrollHeight * 0.42)));
    await say('Step 10 - Stream inference over the authenticated session');
    await typeSlowly('#prompt', 'Summarize how ARCHcore settles a rental', 'prompt input');
    await moveAndClick('#generate-inference', 'generate', 4200);
    await page.waitForTimeout(2600);
    await pan('#transcript .turn', 4);

    await scrollTo(await page.evaluate(() => Math.round(document.body.scrollHeight * 0.62)));
    await say('Step 11 - Escrow, expiry and settlement stay enforceable');
    await pan('.lifecycle-panel .stat, .lifecycle-track li', 5);
    await page.waitForTimeout(1500);
    await say('');
    await page.waitForTimeout(900);

  };

    if (REHEARSE) {
      await journey();
      console.log(`REHEARSAL COMPLETE — ${failures} step failure(s)`);
      if (failures) process.exitCode = 1;
      return;
    }

    await journey();

    const videoRef = page.video();
    await context.close();
    context = null;

    const dest = resolve(OUT_DIR, 'archcore-renter-journey.webm');
    if (videoRef) {
      const rawPath = await videoRef.path().catch(() => null);
      if (rawPath && existsSync(rawPath)) {
        copyFileSync(rawPath, dest);
        try { unlinkSync(rawPath); } catch {}
      }
    }
    // Clean up any other page@*.webm files in OUT_DIR
    try {
      for (const file of readdirSync(OUT_DIR)) {
        if (file.startsWith('page@') && file.endsWith('.webm')) {
          try { unlinkSync(resolve(OUT_DIR, file)); } catch {}
        }
      }
    } catch {}

    console.log(`VIDEO: ${dest} (${(statSync(dest).size / 1024).toFixed(0)} KB)`);
    console.log(`CONSOLE/PAGE ERRORS: ${errors.length} ${JSON.stringify(errors)}`);
    if (errors.length || failures) process.exitCode = 1;
  } finally {
    clearTimeout(rehearsalTimeout);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    sessions.stop();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
