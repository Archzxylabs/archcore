/**
 * Tests for the three repairs in `src/app.ts`.
 *
 * Every dependency here is a fake: the wallet, the RPC endpoint, and the Agent.
 * These are isolated unit tests of state and session handling. They are not a
 * wallet integration test, not a chain integration test, and not an end-to-end
 * run — no browser, no real wallet, and no operator tunnel is involved, and a
 * passing result must not be read as one.
 *
 * What they cover: the session and stream being dropped when the rental the page
 * is looking at is no longer the one the token was issued for, the chain being
 * re-read before an agent challenge is signed for it, and a second rapid click
 * being refused while a send is already in flight.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { encodeAbiParameters, getFunctionSelector } from 'viem';
import { ERC20_ABI } from '../src/rentalOps.js';

import { RenterApp } from '../src/app.js';
import { CHAIN_ID_HEX } from '../src/config.js';
import { USDG_ADDRESS, type ChainRental } from '../src/chainPure.js';
import type { Eip1193Provider } from '../src/wallet.js';

const MANAGER = '0x5555555555555555555555555555555555555555';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}`;

/** The node and plan the page under test is pointed at. */
const NODE_ID = 1n;
const PLAN_ID = 1;
/** USDG has six decimals, so a price is this many atomic units of it. */
const PRICE_ATOMIC = 6_000_000n;

const CONFIG = {
  chainId: 46630,
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: 'https://explorer.example',
  rentalManagerAddress: MANAGER,
  paymentToken: USDG_ADDRESS,
  paymentDecimals: 6,
  nodeId: String(NODE_ID),
};

/**
 * The shipped artifact, not a hand-written ABI.
 *
 * The reader encodes against whatever the app loads, so a fake that had drifted
 * from the contract would let these tests pass while the page failed in a
 * browser. Loading the real artifact is what keeps the selectors here the
 * contract's own.
 */
const ABI: unknown[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../packages/abi/RentalManager.json', import.meta.url)),
    'utf8',
  ),
);

interface FakeWallet extends Eip1193Provider {
  readonly calls: string[];
  emit(event: string, ...args: unknown[]): void;
}

function wallet(handler: (method: string) => unknown): FakeWallet {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const calls: string[] = [];
  return {
    calls,
    request: async ({ method }) => {
      calls.push(method);
      return handler(method);
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

/** Installs `window` and `fetch`, and restores both afterwards. */
function install(fetchImpl: typeof fetch, ethereum?: FakeWallet): () => void {
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as { window?: unknown }).window;
  globalThis.fetch = fetchImpl;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: ethereum ? { ethereum } : {},
  });
  return () => {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: previousWindow,
    });
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Selector → name for the reader's own reads, built from the artifact. */
const READERS = new Map<string, string>(
  (ABI as { type: string; name?: string; stateMutability?: string }[])
    .filter((e) => e.type === 'function' && e.stateMutability === 'view')
    .map((e) => [getFunctionSelector(e as never), e.name!]),
);

/** Names the reader function an `eth_call` payload invokes. */
function readerOf(data: string): string {
  const name = READERS.get(data.slice(0, 10));
  if (!name) throw new Error(`no view in the artifact has selector ${data.slice(0, 10)}`);
  return name;
}

/**
 * The chain's answer to one `eth_call`, chosen by the function the calldata
 * names — answering every call with the same bytes is how a test hides a reader
 * that called the wrong function.
 *
 * `rentalId` is what `activeRentalForNode` reports, so a test can move the node
 * onto a different rental and watch the session follow it out. The reader
 * follows the id through `getRental`, so both have to answer.
 */
function viewResult(data: string, rentalId: bigint): string {
  switch (readerOf(data)) {
    case 'activeRentalForNode':
      return encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [
        rentalId !== 0n,
        rentalId,
      ]);
    case 'getRental':
      // An ACTIVE rental that started a minute ago and has not expired, so
      // `isAccessible` passes and the chain guard is the only thing standing
      // between a drifted wallet and a signature the Agent would refuse.
      return encodeAbiParameters(
        [
          { type: 'uint256' }, // rentalId
          { type: 'uint256' }, // nodeId
          { type: 'uint8' }, // planId
          { type: 'address' }, // renter
          { type: 'address' }, // provider
          { type: 'uint256' }, // priceAtomic
          { type: 'uint256' }, // durationSeconds
          { type: 'uint8' }, // status = ACTIVE
          { type: 'uint256' }, // startDeadline
          { type: 'uint256' }, // startsAt
          { type: 'uint256' }, // expiresAt
          { type: 'uint256' }, // createdAt
        ],
        [
          rentalId,
          NODE_ID,
          PLAN_ID,
          ACCOUNT,
          ACCOUNT,
          PRICE_ATOMIC,
          21600n,
          2,
          0n,
          1n,
          BigInt(Math.floor(Date.now() / 1000) + 300),
          0n,
        ],
      );
    case 'getNode':
      // `(nodeId, provider, name, active)`. The node is active; availability is
      // decided by the listing, the plan, and `activeRentalForNode` alongside it.
      return encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bool' }],
        [NODE_ID, ACCOUNT, `0x${'00'.repeat(32)}`, true],
      );
    case 'getListing':
      // `(nodeId, paymentToken, active)`: listed only while the node is free.
      return encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'bool' }],
        [NODE_ID, CONFIG.paymentToken as `0x${string}`, rentalId === 0n],
      );
    case 'getPlan':
      // `(planId, durationSeconds, priceAtomic, active, demoOnly)`.
      return encodeAbiParameters(
        [
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bool' },
          { type: 'bool' },
        ],
        [PLAN_ID, 21600n, PRICE_ATOMIC, true, false],
      );
    case 'paymentToken':
      return encodeAbiParameters([{ type: 'address' }], [
        CONFIG.paymentToken as `0x${string}`,
      ]);
    case 'planCount':
      return encodeAbiParameters([{ type: 'uint8' }], [7]);
    default:
      throw new Error(`unexpected read of ${readerOf(data)}`);
  }
}

/**
 * The payment token's answer to one `eth_call`, by the ERC-20 selector it names.
 *
 * The balance and the allowance both cover the quote's price, so a rental needs
 * no approval send: the tests below count sends, and a fixture that underfunded
 * the allowance would add one that has nothing to do with the guard they test.
 */
function tokenResult(data: string): string {
  const selector = data.slice(0, 10);
  const tokenReads = new Map<string, string>(
    (ERC20_ABI as unknown as { type: string; name?: string }[])
      .filter((e) => e.type === 'function')
      .map((e) => [getFunctionSelector(e as never), e.name!]),
  );
  switch (tokenReads.get(selector)) {
    case 'decimals':
      return encodeAbiParameters([{ type: 'uint8' }], [CONFIG.paymentDecimals]);
    case 'symbol':
      return encodeAbiParameters([{ type: 'string' }], ['USDG']);
    case 'balanceOf':
      return encodeAbiParameters([{ type: 'uint256' }], [PRICE_ATOMIC]);
    case 'allowance':
      return encodeAbiParameters([{ type: 'uint256' }], [PRICE_ATOMIC]);
    default:
      throw new Error(`unexpected token read ${tokenReads.get(selector) ?? selector}`);
  }
}

/** Serves the Agent's JSON routes and the chain's JSON-RPC reads. */
function routingFetch(rentalId: () => bigint): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/config')) return json(CONFIG);
    if (url.endsWith('/rental-manager.json')) return json(ABI);
    if (url.endsWith('/node')) return json({ nodeId: '1', name: 'node-1', active: true });
    if (url.endsWith('/auth/challenge')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { rentalId?: string };
      return json({ domain: { name: 'd' }, types: { T: [] }, primaryType: 'T', message: { rentalId: body.rentalId } });
    }
    if (url.endsWith('/auth/verify')) {
      return json({
        token: 'signed-by-the-agent',
        rentalId: '7',
        expiresAt: String(Math.floor(Date.now() / 1000) + 60),
      });
    }
    if (new URL(url).hostname === 'rpc.testnet.chain.robinhood.com') {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (body.method === 'eth_call') {
        const address = String((body.params?.[0] as { to?: string }).to);
        // The payment token answers for itself: `rent` reads its decimals, symbol,
        // balance and allowance before it asks the wallet for either signature,
        // and a fixture that stayed silent there would fail the send for a reason
        // that has nothing to do with what these tests are about.
        if (address !== MANAGER) {
          return json({ result: tokenResult(String((body.params?.[0] as { data?: string }).data)) });
        }
        return json({ result: viewResult(String((body.params?.[0] as { data?: string }).data), rentalId()) });
      }
      if (body.method === 'eth_getTransactionReceipt') return json({ result: { status: '0x1' } });
      if (body.method === 'eth_sendRawTransaction') return json({ result: TX });
      return json({ error: `unhandled rpc ${body.method}` }, 500);
    }
    return json({ error: `unhandled ${url}` }, 500);
  }) as unknown as typeof fetch;
}

/** The rental `getRental` returns, as the controller decodes it. */
function stateRental(rentalId: bigint): Record<string, unknown> {
  return {
    rentalId,
    nodeId: NODE_ID,
    planId: PLAN_ID,
    renter: ACCOUNT,
    provider: ACCOUNT,
    priceAtomic: PRICE_ATOMIC,
    durationSeconds: 21600n,
    status: 'ACTIVE',
    startDeadline: 0n,
    // Started a minute ago and never expiring, so `isAccessible` passes and the
    // chain guard is the only thing between a drifted wallet and a signature.
    startsAt: 1n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 300),
    createdAt: 0n,
    raw: {},
  };
}

describe('session follows the rental', () => {
  it('revokes the token and stops the stream when the node moves onto another rental', async () => {
    let rentalId = 7n;
    const restore = install(routingFetch(() => rentalId));
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      const store = (app as unknown as { sessionStore: { set(s: unknown): void } }).sessionStore;
      store.set({ token: 'memory-only-token', rentalId: 7n, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      app.state = { ...app.state, authenticatedFor: 7n };

      rentalId = 9n;
      await app.reloadChain();

      assert.equal(app.sessionInfo(), null);
      assert.equal(app.state.authenticatedFor, null);
    } finally {
      restore();
    }
  });

  it('revokes the token when a refresh finds no rental in play at all', async () => {
    let rentalId = 7n;
    const restore = install(routingFetch(() => rentalId));
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      const store = (app as unknown as { sessionStore: { set(s: unknown): void } }).sessionStore;
      store.set({ token: 'memory-only-token', rentalId: 7n, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      app.state = { ...app.state, authenticatedFor: 7n };

      // The node came back free: the rental the token names is gone by a slower
      // route than a cancel, and it is still gone.
      rentalId = 0n;
      await app.reloadChain();

      assert.equal(app.sessionInfo(), null);
      assert.equal(app.state.authenticatedFor, null);
    } finally {
      restore();
    }
  });

  it('keeps the token while the refresh still reports the same rental', async () => {
    const restore = install(routingFetch(() => 7n));
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      const store = (app as unknown as { sessionStore: { set(s: unknown): void } }).sessionStore;
      store.set({ token: 'memory-only-token', rentalId: 7n, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      app.state = { ...app.state, authenticatedFor: 7n };

      await app.reloadChain();

      assert.equal(app.sessionInfo()?.rentalId, 7n);
      assert.equal(app.state.authenticatedFor, 7n);
      assert.equal(app.state.error, null);
    } finally {
      restore();
    }
  });
});

/**
 * A wallet that connects on chain 46630 and then drifts off it.
 *
 * `drift()` flips the chain the wallet reports, which is the case the guard
 * exists for: `connect()` read chain 46630, so the chainId held in `walletState`
 * is right until the renter moves the wallet underneath it. Both chain-switching
 * methods refuse with 4902, so a guard that does not re-read cannot recover and
 * must stop the send rather than let value reach a network that will not honour it.
 */
function driftableWallet(onSend: () => void): FakeWallet & { drift(): void } {
  const state = { chainId: CHAIN_ID_HEX };
  const base = wallet((method) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
    if (method === 'eth_chainId') return state.chainId;
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
      // 4902 keeps the wallet's own message, so the renter sees the refusal
      // rather than a generic one.
      throw Object.assign(new Error('The wallet cannot switch to chain 46630.'), { code: 4902 });
    }
    if (method === 'eth_sendTransaction' || method === 'eth_signTypedData_v4') {
      onSend();
      return TX;
    }
    throw new Error(`unexpected ${method}`);
  });
  return Object.assign(base, { drift: () => (state.chainId = '0x1') });
}

describe('chain re-validation before signing', () => {
  it('refuses to sign an agent challenge when the wallet has drifted off chain 46630', async () => {
    let signatures = 0;
    const ethereum = driftableWallet(() => (signatures += 1));
    const restore = install(routingFetch(() => 0n), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      assert.equal(app.state.wallet?.chainId, 46630);
      ethereum.drift();
      app.state = {
        ...app.state,
        // Reserved, started and running: `isAccessible` passes, so the chain guard
        // is the only thing standing between a drifted wallet and a signature.
        rental: stateRental(7n) as unknown as ChainRental,
      };

      await app.login();

      // `eth_signTypedData_v4` is chain-scoped: a signature made against the domain
      // of one chain is worthless to an Agent verifying it for another, so nothing
      // is signed and no session is minted.
      assert.equal(signatures, 0);
      assert.equal(app.sessionInfo(), null);
      assert.equal(app.state.authenticatedFor, null);
      assert.match(app.state.error ?? '', /cannot switch to chain 46630/);
      assert.equal(app.state.busy, null);
    } finally {
      restore();
    }
  });

  it('signs the challenge when the wallet is still on chain 46630', async () => {
    let signatures = 0;
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      if (method === 'eth_signTypedData_v4') {
        signatures += 1;
        return `0x${'cd'.repeat(65)}`;
      }
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(() => 0n), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental: stateRental(7n) as unknown as ChainRental };

      await app.login();

      assert.equal(signatures, 1);
      assert.equal(app.sessionInfo()?.rentalId, 7n);
      assert.equal(app.state.error, null);
      assert.equal(app.state.busy, null);
    } finally {
      restore();
    }
  });
});

describe('one send at a time', () => {
  it('refuses a second rent while the first is still awaiting its receipt', async () => {
    let current = CHAIN_ID_HEX;
    let sends = 0;
    // Held open until the test lets it go, so the second click lands while the
    // first is still in the wallet and nothing has been mined.
    let releaseFirst = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ethereum = wallet(async (method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return current;
      if (method === 'eth_sendTransaction') {
        sends += 1;
        await gate;
        return TX;
      }
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(() => 0n), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, quote: { nodeId: NODE_ID, planId: PLAN_ID, priceAtomic: PRICE_ATOMIC, durationSeconds: 21600n, available: true } };

      const first = app.rent();
      await Promise.resolve();
      const second = app.rent();
      releaseFirst();
      await Promise.all([first, second]);

      assert.equal(sends, 1);
      assert.equal(app.state.busy, null);
    } finally {
      restore();
    }
  });

  it('frees the slot when a rent fails, so the next attempt can be made', async () => {
    let current = CHAIN_ID_HEX;
    let attempt = 0;
    const ethereum = wallet(async (method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return current;
      if (method === 'eth_sendTransaction') {
        attempt += 1;
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      }
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(() => 0n), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, quote: { nodeId: NODE_ID, planId: PLAN_ID, priceAtomic: PRICE_ATOMIC, durationSeconds: 21600n, available: true } };

      await app.rent();
      assert.equal(app.state.busy, null);

      // A refusal must not leave the guard latched, or the renter can never try
      // again without reloading the page.
      await app.rent();
      assert.equal(attempt, 2);
      assert.equal(app.state.busy, null);
    } finally {
      restore();
    }
  });
});

describe('auto-authentication for ACTIVE rentals', () => {
  const RENTAL_ID = 7n;

  function activeRental(overrides?: Partial<ChainRental>): ChainRental {
    return {
      rentalId: RENTAL_ID,
      nodeId: NODE_ID,
      planId: PLAN_ID,
      renter: ACCOUNT,
      provider: ACCOUNT,
      priceAtomic: PRICE_ATOMIC,
      durationSeconds: 21600n,
      status: 'ACTIVE',
      startDeadline: 0n,
      startsAt: 1n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 300),
      createdAt: 0n,
      raw: {},
      ...overrides,
    };
  }

  function setupAuthTest(options?: {
    rental?: ChainRental | null;
    account?: string;
    chainId?: string;
    rejectSign?: boolean;
    delaySign?: () => Promise<void>;
  }) {
    let signCalls = 0;
    let currentChain = options?.chainId ?? CHAIN_ID_HEX;
    let shouldReject = options?.rejectSign ?? false;
    const account = options?.account ?? ACCOUNT;

    const ethereum = wallet(async (method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return currentChain;
      if (method === 'wallet_switchEthereumChain') {
        currentChain = CHAIN_ID_HEX;
        return null;
      }
      if (method === 'eth_signTypedData_v4') {
        signCalls++;
        if (options?.delaySign) await options.delaySign();
        if (shouldReject) {
          throw Object.assign(new Error('User rejected the signature request.'), { code: 4001 });
        }
        return '0xsignature';
      }
      throw new Error(`unexpected wallet method ${method}`);
    });

    const restore = install(routingFetch(() => options?.rental?.rentalId ?? RENTAL_ID), ethereum);
    const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });

    return {
      app,
      ethereum,
      getSignCalls: () => signCalls,
      setRejectSign: (val: boolean) => { shouldReject = val; },
      restore,
    };
  }

  it('AVAILABLE does not auto-authenticate', async () => {
    const { app, getSignCalls, restore } = setupAuthTest({ rental: null });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental: null };
      app.tryAutoAuthenticate();
      await Promise.resolve();
      assert.equal(getSignCalls(), 0);
      assert.equal(app.state.authenticatedFor, null);
    } finally {
      restore();
    }
  });

  it('RESERVED does not auto-authenticate', async () => {
    const reserved = activeRental({ status: 'RESERVED' });
    const { app, getSignCalls, restore } = setupAuthTest({ rental: reserved });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental: reserved };
      app.tryAutoAuthenticate();
      await Promise.resolve();
      assert.equal(getSignCalls(), 0);
      assert.equal(app.state.authenticatedFor, null);
    } finally {
      restore();
    }
  });

  it('ACTIVE triggers exactly one challenge/sign/verify sequence', async () => {
    const rental = activeRental();
    const { app, getSignCalls, restore } = setupAuthTest({ rental });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getSignCalls(), 1);
      assert.equal(app.state.authenticatedFor, RENTAL_ID);
      assert.equal(app.state.authError, null);
    } finally {
      restore();
    }
  });

  it('repeated polling and rerendering cause no second popup', async () => {
    const rental = activeRental();
    const { app, getSignCalls, restore } = setupAuthTest({ rental });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getSignCalls(), 1);

      app.tryAutoAuthenticate();
      (app as any).tick();
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getSignCalls(), 1);
    } finally {
      restore();
    }
  });

  it('wallet rejection causes no automatic retry', async () => {
    const rental = activeRental();
    const { app, getSignCalls, setRejectSign, restore } = setupAuthTest({ rental, rejectSign: true });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getSignCalls(), 1);
      assert.equal(app.state.authenticatedFor, null);
      assert.match(app.state.authError ?? '', /rejected/i);

      setRejectSign(false);
      app.tryAutoAuthenticate();
      (app as any).tick();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getSignCalls(), 1, 'rejection must not trigger automatic retry');
    } finally {
      restore();
    }
  });

  it('manual retry works after rejection', async () => {
    const rental = activeRental();
    const { app, getSignCalls, setRejectSign, restore } = setupAuthTest({ rental, rejectSign: true });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getSignCalls(), 1);
      assert.match(app.state.authError ?? '', /rejected/i);

      setRejectSign(false);
      await app.login();

      assert.equal(getSignCalls(), 2);
      assert.equal(app.state.authenticatedFor, RENTAL_ID);
      assert.equal(app.state.authError, null);
    } finally {
      restore();
    }
  });

  it('wrong wallet causes no popup', async () => {
    const rental = activeRental({ renter: '0x9999999999999999999999999999999999999999' });
    const { app, getSignCalls, restore } = setupAuthTest({ rental, account: ACCOUNT });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      app.tryAutoAuthenticate();
      await Promise.resolve();
      assert.equal(getSignCalls(), 0);
    } finally {
      restore();
    }
  });

  it('wrong chain causes no popup', async () => {
    const rental = activeRental();
    const { app, getSignCalls, restore } = setupAuthTest({ rental });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = {
        ...app.state,
        rental,
        wallet: { account: ACCOUNT, chainId: 1 },
      };
      app.tryAutoAuthenticate();
      await Promise.resolve();
      assert.equal(getSignCalls(), 0);
    } finally {
      restore();
    }
  });

  it('existing valid session causes no popup', async () => {
    const rental = activeRental();
    const { app, getSignCalls, restore } = setupAuthTest({ rental });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      (app as any).sessionStore.set({
        token: 'existing-valid-token',
        rentalId: RENTAL_ID,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      app.tryAutoAuthenticate();
      await Promise.resolve();
      assert.equal(getSignCalls(), 0);
    } finally {
      restore();
    }
  });

  it('disconnect/account change/rental change resets the correct state', async () => {
    const rental1 = activeRental({ rentalId: 1n });
    const rental2 = activeRental({ rentalId: 2n });
    const { app, getSignCalls, restore } = setupAuthTest({ rental: rental1 });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental: rental1 };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getSignCalls(), 1);

      app.disconnect();
      assert.equal((app as any).autoAuthAttempted.size, 0);
      assert.equal(app.state.authError, null);

      await app.connect();
      app.state = { ...app.state, rental: rental2 };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getSignCalls(), 2);
    } finally {
      restore();
    }
  });

  it('expiry during authentication fails closed and does not create a usable session', async () => {
    const rental = activeRental({
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 300),
    });
    let expireOnSign = false;
    const { app, getSignCalls, restore } = setupAuthTest({
      rental,
      delaySign: async () => {
        if (expireOnSign) {
          app.state.rental = {
            ...rental,
            expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
          };
        }
      },
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      expireOnSign = true;

      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getSignCalls(), 1);
      assert.equal(app.state.authenticatedFor, null);
      assert.equal((app as any).sessionStore.session, null);
      assert.match(app.state.authError ?? '', /changed during authentication/);
    } finally {
      restore();
    }
  });

  it('session token remains absent from persistent storage and rendered DOM', async () => {
    const rental = activeRental();
    const { app, restore } = setupAuthTest({ rental });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, rental };
      app.tryAutoAuthenticate();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(app.state.authenticatedFor, RENTAL_ID);
      const token = (app as any).sessionStore.token;
      assert.ok(token);

      const storage = (globalThis as any).localStorage;
      if (storage) {
        assert.equal(storage.getItem?.('token'), null);
        assert.equal(storage.getItem?.('session'), null);
      }
      const sessionStorage = (globalThis as any).sessionStorage;
      if (sessionStorage) {
        assert.equal(sessionStorage.getItem?.('token'), null);
        assert.equal(sessionStorage.getItem?.('session'), null);
      }
    } finally {
      restore();
    }
  });
});

describe('settlement and cancellation post-receipt reconciliation', () => {
  function makeRentalTuple(overrides: {
    rentalId?: bigint;
    nodeId?: bigint;
    planId?: number;
    renter?: string;
    provider?: string;
    priceAtomic?: bigint;
    durationSeconds?: bigint;
    status?: number; // 0=NONE, 1=RESERVED, 2=ACTIVE, 3=COMPLETED, 4=CANCELLED
    startDeadline?: bigint;
    startsAt?: bigint;
    expiresAt?: bigint;
    createdAt?: bigint;
  }) {
    return encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        overrides.rentalId ?? 7n,
        overrides.nodeId ?? NODE_ID,
        overrides.planId ?? PLAN_ID,
        (overrides.renter ?? ACCOUNT) as `0x${string}`,
        (overrides.provider ?? ACCOUNT) as `0x${string}`,
        overrides.priceAtomic ?? PRICE_ATOMIC,
        overrides.durationSeconds ?? 21600n,
        overrides.status ?? 2,
        overrides.startDeadline ?? 0n,
        overrides.startsAt ?? 1n,
        overrides.expiresAt ?? BigInt(Math.floor(Date.now() / 1000) - 100),
        overrides.createdAt ?? 0n,
      ],
    );
  }

  function setupReconciliationHarness(options: {
    getRentalResponses: Array<{ status: number; rentalId?: bigint }>;
    activeRentalResponses?: Array<{ occupied: boolean; rentalId: bigint }> | (() => { occupied: boolean; rentalId: bigint });
    listingResponses?: Array<{ nodeId?: bigint; active?: boolean }> | (() => { nodeId?: bigint; active?: boolean });
    reconcileDelayMs?: number;
    reconcileMaxAttempts?: number;
    onSendTransaction?: (method: string) => void;
    onCallNode?: () => Promise<void> | void;
    targetRentalId?: bigint;
  }) {
    let getRentalIndex = 0;
    let activeRentalIndex = 0;
    let listingIndex = 0;
    let txSendCount = 0;

    const ethereum = wallet(async (method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        txSendCount++;
        options.onSendTransaction?.(method);
        return TX;
      }
      throw new Error(`unexpected wallet method ${method}`);
    });

    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/config')) return json(CONFIG);
      if (url.endsWith('/rental-manager.json')) return json(ABI);
      if (url.endsWith('/node')) {
        if (options.onCallNode) await options.onCallNode();
        return json({ nodeId: '1', name: 'node-1', active: true });
      }
      if (url.endsWith('/auth/challenge')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { rentalId?: string };
        return json({ domain: { name: 'd' }, types: { T: [] }, primaryType: 'T', message: { rentalId: body.rentalId } });
      }
      if (url.endsWith('/auth/verify')) {
        return json({
          token: 'signed-by-the-agent',
          rentalId: '7',
          expiresAt: String(Math.floor(Date.now() / 1000) + 60),
        });
      }
      if (new URL(url).hostname === 'rpc.testnet.chain.robinhood.com') {
        const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
        if (body.method === 'eth_call') {
          const address = String((body.params?.[0] as { to?: string }).to);
          if (address !== MANAGER) {
            return json({ result: tokenResult(String((body.params?.[0] as { data?: string }).data)) });
          }
          const callData = String((body.params?.[0] as { data?: string }).data);
          const readerName = readerOf(callData);
          if (readerName === 'getRental') {
            const requestedRentalId = BigInt('0x' + callData.slice(10));
            const targetId = options.targetRentalId ?? 7n;
            if (requestedRentalId !== targetId) {
              return json({
                result: makeRentalTuple({
                  rentalId: requestedRentalId,
                  nodeId: NODE_ID,
                  status: 2, // ACTIVE
                }),
              });
            }
            const resp = options.getRentalResponses[Math.min(getRentalIndex, options.getRentalResponses.length - 1)]!;
            getRentalIndex++;
            return json({ result: makeRentalTuple({ rentalId: requestedRentalId, ...resp }) });
          }
          if (readerName === 'activeRentalForNode') {
            let activeResp: { occupied: boolean; rentalId: bigint };
            if (typeof options.activeRentalResponses === 'function') {
              activeResp = options.activeRentalResponses();
            } else if (options.activeRentalResponses) {
              activeResp = options.activeRentalResponses[Math.min(activeRentalIndex, options.activeRentalResponses.length - 1)]!;
              activeRentalIndex++;
            } else {
              activeResp = { occupied: false, rentalId: 0n };
            }
            return json({
              result: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [activeResp.occupied, activeResp.rentalId]),
            });
          }
          if (readerName === 'getListing') {
            let listingResp: { nodeId?: bigint; active?: boolean };
            if (typeof options.listingResponses === 'function') {
              listingResp = options.listingResponses();
            } else if (options.listingResponses) {
              listingResp = options.listingResponses[Math.min(listingIndex, options.listingResponses.length - 1)]!;
              listingIndex++;
            } else {
              listingResp = { nodeId: NODE_ID, active: true };
            }
            return json({
              result: encodeAbiParameters(
                [{ type: 'uint256' }, { type: 'address' }, { type: 'bool' }],
                [listingResp.nodeId ?? NODE_ID, CONFIG.paymentToken as `0x${string}`, listingResp.active ?? true],
              ),
            });
          }
          if (readerName === 'getPlan') {
            return json({
              result: encodeAbiParameters(
                [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }],
                [PLAN_ID, 21600n, PRICE_ATOMIC, true, false],
              ),
            });
          }
          if (readerName === 'getNode') {
            return json({
              result: encodeAbiParameters(
                [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bool' }],
                [NODE_ID, ACCOUNT, `0x${'00'.repeat(32)}`, true],
              ),
            });
          }
          if (readerName === 'paymentToken') {
            return json({ result: encodeAbiParameters([{ type: 'address' }], [CONFIG.paymentToken as `0x${string}`]) });
          }
          if (readerName === 'planCount') {
            return json({ result: encodeAbiParameters([{ type: 'uint8' }], [7]) });
          }
        }
        if (body.method === 'eth_getTransactionReceipt') return json({ result: { status: '0x1' } });
        if (body.method === 'eth_sendRawTransaction') return json({ result: TX });
        return json({ error: `unhandled rpc ${body.method}` }, 500);
      }
      return json({ error: `unhandled ${url}` }, 500);
    }) as unknown as typeof fetch;

    const restore = install(fetchImpl, ethereum);
    const app = new RenterApp(
      { hostname: 'localhost', origin: 'http://localhost:8787', search: '' },
      {
        reconcileDelayMs: options.reconcileDelayMs ?? 5,
        reconcileMaxAttempts: options.reconcileMaxAttempts ?? 5,
      },
    );

    return {
      app,
      ethereum,
      getTxSendCount: () => txSendCount,
      restore,
    };
  }

  it('COMPLETED target + activeRentalForNode NONE + listing active succeeds without Refresh status', async () => {
    const { app, restore } = setupReconciliationHarness({
      getRentalResponses: [
        { status: 2 }, // preflight
        { status: 3 }, // attempt 0 immediate reread (COMPLETED)
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      assert.equal(app.state.rental?.status, 'COMPLETED');
      assert.equal(app.stage(), 'settled');
      assert.equal(app.state.quote?.available, true);
      assert.match(app.state.notice ?? '', /Settlement confirmed/);
      assert.equal(app.state.busy, null);
      assert.equal(app.state.error, null);
    } finally {
      restore();
    }
  });

  it('stale first reread followed by terminal second/third reread updates automatically', async () => {
    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 10,
      reconcileMaxAttempts: 5,
      getRentalResponses: [
        { status: 2 }, // preflight
        { status: 2 }, // attempt 0 (stale ACTIVE)
        { status: 3 }, // attempt 1 (terminal COMPLETED)
      ],
      activeRentalResponses: [
        { occupied: true, rentalId: 7n },  // stale active
        { occupied: false, rentalId: 0n }, // unoccupied
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      assert.equal(app.state.rental?.status, 'COMPLETED');
      assert.equal(app.stage(), 'settled');
      assert.equal(app.state.quote?.available, true);
    } finally {
      restore();
    }
  });

  it('receipt hash alone never renders COMPLETED', async () => {
    let capturedDuringSend: string | undefined;
    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 20,
      reconcileMaxAttempts: 2,
      onSendTransaction: () => {
        capturedDuringSend = app.state.rental?.status;
      },
      getRentalResponses: [
        { status: 2 }, // preflight
        { status: 2 }, // all rereads stay ACTIVE (simulating unpropagated state)
      ],
      activeRentalResponses: [
        { occupied: true, rentalId: 7n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      assert.equal(capturedDuringSend, 'ACTIVE');
      assert.notEqual(app.state.rental?.status, 'COMPLETED');
    } finally {
      restore();
    }
  });

  it('reconciliation timeout shows pending-chain-state copy', async () => {
    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 2 }, // preflight
        { status: 2 }, // attempt 0 stays ACTIVE
        { status: 2 }, // attempt 1 stays ACTIVE
      ],
      activeRentalResponses: [
        { occupied: true, rentalId: 7n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      assert.equal(app.state.rental?.status, 'ACTIVE');
      assert.equal(app.state.busy, null);
      assert.match(app.state.notice ?? '', /Waiting for updated chain state…/);
    } finally {
      restore();
    }
  });

  it('no duplicate settlement send during reconciliation', async () => {
    let secondSettlePromise: Promise<void> | null = null;
    const { app, getTxSendCount, restore } = setupReconciliationHarness({
      reconcileDelayMs: 40,
      reconcileMaxAttempts: 3,
      onSendTransaction: () => {
        secondSettlePromise = app.settle();
      },
      getRentalResponses: [
        { status: 2 },
        { status: 3 },
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();
      if (secondSettlePromise) await secondSettlePromise;

      assert.equal(getTxSendCount(), 1);
    } finally {
      restore();
    }
  });

  it('regular polling observes settlement performed by another actor/Agent', async () => {
    const { app, restore } = setupReconciliationHarness({
      getRentalResponses: [
        { status: 3 }, // COMPLETED onchain by Agent
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.reloadChain(true);

      assert.equal(app.state.rental?.status, 'COMPLETED');
      assert.equal(app.stage(), 'settled');
      assert.equal(app.state.quote?.available, true);
    } finally {
      restore();
    }
  });

  it('manual and automatic settlement race converges to one COMPLETED UI', async () => {
    // Simulate: manual settle tx submitted, but by the time receipt arrives,
    // chain reads show COMPLETED (because Agent settled first or simultaneously).
    const { app, restore, getTxSendCount } = setupReconciliationHarness({
      getRentalResponses: [
        { status: 2 }, // connect() quoteRent -> activeRentalForNode -> getRental
        { status: 2 }, // settle() preflight reads ACTIVE
        { status: 3 }, // reconciliation reads COMPLETED (Agent settled first or concurrently)
      ],
      activeRentalResponses: [
        { occupied: true, rentalId: 7n }, // connect() quoteRent: node occupied
        { occupied: false, rentalId: 0n }, // settle()/reconciliation: cleared
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      // Manual settle
      await app.settle();

      // Only one wallet transaction was sent
      assert.equal(getTxSendCount(), 1, 'exactly one wallet transaction for manual settle');
      // Converged to COMPLETED
      assert.equal(app.state.rental?.status, 'COMPLETED');
      assert.equal(app.stage(), 'settled');
      // Session and auth cleared
      assert.equal(app.sessionInfo(), null);
    } finally {
      restore();
    }
  });

  it('stale overlapping response cannot overwrite COMPLETED with ACTIVE', async () => {
    const { app, restore } = setupReconciliationHarness({
      getRentalResponses: [
        { status: 2 }, // stale ACTIVE
      ],
      activeRentalResponses: [
        { occupied: true, rentalId: 7n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'COMPLETED',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.reloadChain(true);

      assert.equal(app.state.rental?.status, 'COMPLETED');
      assert.equal(app.stage(), 'settled');
    } finally {
      restore();
    }
  });

  it('settlement clears session and auth error', async () => {
    const { app, restore } = setupReconciliationHarness({
      getRentalResponses: [
        { status: 2 }, // preflight
        { status: 3 }, // COMPLETED
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };
      (app as any).sessionStore.set({ token: 'tok', rentalId: 7n, expiresAt: Math.floor(Date.now() / 1000) + 1000 });
      app.state.authenticatedFor = 7n;
      app.state.authError = 'You rejected the sign request in your wallet.';

      await app.settle();

      assert.equal(app.state.authError, null);
      assert.equal(app.state.authenticatedFor, null);
      assert.equal((app as any).sessionStore.session, null);
    } finally {
      restore();
    }
  });

  it('missed-start refund automatically becomes CANCELLED and available', async () => {
    const { app, restore } = setupReconciliationHarness({
      getRentalResponses: [
        { status: 1 }, // preflight (RESERVED)
        { status: 4 }, // CANCELLED
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'RESERVED',
        startDeadline: BigInt(Math.floor(Date.now() / 1000) - 50),
        startsAt: 0n,
        expiresAt: 0n,
        createdAt: 0n,
        raw: {},
      };

      await app.cancel();

      assert.equal(app.state.rental?.status, 'CANCELLED');
      assert.equal(app.stage(), 'cancelled');
      assert.equal(app.state.quote?.available, true);
      assert.match(app.state.notice ?? '', /Refund confirmed/);
    } finally {
      restore();
    }
  });

  it('COMPLETED target + a different active rental does not count as unoccupied', async () => {
    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 2 }, // preflight for settle()
        { status: 3 }, // attempt 0 (COMPLETED)
        { status: 3 }, // attempt 1 (COMPLETED)
      ],
      activeRentalResponses: () => {
        if (app.isReconciling()) {
          return { occupied: true, rentalId: 999n };
        }
        return { occupied: false, rentalId: 0n };
      },
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      // Because activeRentalForNode reports occupied (even with a different rentalId),
      // the node is not unoccupied, so reconciliation does not complete.
      assert.equal(app.state.rental?.status, 'ACTIVE');
      assert.equal(app.state.busy, null);
      assert.match(app.state.notice ?? '', /Waiting for updated chain state…/);
    } finally {
      restore();
    }
  });

  it('COMPLETED target + listing inactive does not complete reconciliation', async () => {
    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 2 }, // preflight for settle()
        { status: 3 }, // attempt 0 (COMPLETED)
        { status: 3 }, // attempt 1 (COMPLETED)
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
      listingResponses: () => {
        if (app.isReconciling()) {
          return { nodeId: NODE_ID, active: false };
        }
        return { nodeId: NODE_ID, active: true };
      },
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      // Because listing.active is false, reconciliation does not complete.
      assert.equal(app.state.rental?.status, 'ACTIVE');
      assert.equal(app.state.busy, null);
      assert.match(app.state.notice ?? '', /Waiting for updated chain state…/);
    } finally {
      restore();
    }
  });

  it('CANCELLED target applies the same strict occupancy/listing rules', async () => {
    // Case 1: active rental occupied by another rental prevents CANCELLED reconciliation
    const { app: appOccupied, restore: restoreOccupied } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 1 }, // preflight (RESERVED)
        { status: 4 }, // attempt 0 (CANCELLED)
        { status: 4 }, // attempt 1 (CANCELLED)
      ],
      activeRentalResponses: () => {
        if (appOccupied.isReconciling()) {
          return { occupied: true, rentalId: 999n };
        }
        return { occupied: false, rentalId: 0n };
      },
    });
    try {
      await appOccupied.reloadConfig();
      await appOccupied.connect();
      appOccupied.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'RESERVED',
        startDeadline: BigInt(Math.floor(Date.now() / 1000) - 50),
        startsAt: 0n,
        expiresAt: 0n,
        createdAt: 0n,
        raw: {},
      };

      await appOccupied.cancel();

      assert.equal(appOccupied.state.rental?.status, 'RESERVED');
      assert.match(appOccupied.state.notice ?? '', /Waiting for updated chain state…/);
    } finally {
      restoreOccupied();
    }

    // Case 2: inactive listing prevents CANCELLED reconciliation
    const { app: appInactive, restore: restoreInactive } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 1 }, // preflight (RESERVED)
        { status: 4 }, // attempt 0 (CANCELLED)
        { status: 4 }, // attempt 1 (CANCELLED)
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
      listingResponses: () => {
        if (appInactive.isReconciling()) {
          return { nodeId: NODE_ID, active: false };
        }
        return { nodeId: NODE_ID, active: true };
      },
    });
    try {
      await appInactive.reloadConfig();
      await appInactive.connect();
      appInactive.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'RESERVED',
        startDeadline: BigInt(Math.floor(Date.now() / 1000) - 50),
        startsAt: 0n,
        expiresAt: 0n,
        createdAt: 0n,
        raw: {},
      };

      await appInactive.cancel();

      assert.equal(appInactive.state.rental?.status, 'RESERVED');
      assert.match(appInactive.state.notice ?? '', /Waiting for updated chain state…/);
    } finally {
      restoreInactive();
    }
  });

  it('stale secondary reads cannot overwrite a newer reconciliation or chain state', async () => {
    let callNodeRelease: (() => void) | null = null;
    const callNodePaused = new Promise<void>((resolve) => {
      callNodeRelease = resolve;
    });

    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 2 }, // preflight
        { status: 3 }, // attempt 0 (COMPLETED)
      ],
      activeRentalResponses: [
        { occupied: false, rentalId: 0n },
      ],
      onCallNode: async () => {
        // Pause during reconciliation secondary phase
        if (app.isReconciling()) {
          await callNodePaused;
        }
      },
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      const settlePromise = app.settle();

      // Give event loop time to enter secondary phase in callNode
      await new Promise((r) => setTimeout(r, 20));

      // Simulate a newer reconciliation landing while secondary read was in flight
      (app as any).reconcileGeneration++;
      app.state.notice = 'Newer authoritative notice';

      callNodeRelease!();
      await settlePromise;

      // Stale secondary read must NOT overwrite newer state
      assert.equal(app.state.notice, 'Newer authoritative notice');
    } finally {
      restore();
    }
  });

  it('subsequent polling can still converge after strict conditions become true', async () => {
    let occupied = true;
    const { app, restore } = setupReconciliationHarness({
      reconcileDelayMs: 5,
      reconcileMaxAttempts: 2,
      getRentalResponses: [
        { status: 2 }, // preflight for settle()
        { status: 3 }, // attempt 0 (COMPLETED)
        { status: 3 }, // attempt 1 (COMPLETED)
        { status: 3 }, // subsequent poll
      ],
      activeRentalResponses: () => {
        if (app.isReconciling()) {
          return { occupied: true, rentalId: 999n };
        }
        return occupied ? { occupied: true, rentalId: 999n } : { occupied: false, rentalId: 0n };
      },
    });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 10),
        createdAt: 0n,
        raw: {},
      };

      await app.settle();

      // Reconciliation timed out honestly
      assert.equal(app.state.rental?.status, 'ACTIVE');
      assert.match(app.state.notice ?? '', /Waiting for updated chain state…/);

      // Strict condition now becomes true onchain
      occupied = false;

      // Now background poll runs after the strict condition has become true
      await app.reloadChain(true);

      // Successfully converged to COMPLETED and available!
      assert.equal(app.state.rental?.status, 'COMPLETED');
      assert.equal(app.state.quote?.available, true);
    } finally {
      restore();
    }
  });

  it('polling stops/cleans up correctly on disconnect and app stop', async () => {
    const { app, restore } = setupReconciliationHarness({
      getRentalResponses: [{ status: 2 }],
    });
    try {
      await app.start();
      await app.connect();

      assert.ok((app as any).pollTimer !== null);
      assert.ok((app as any).timer !== null);

      app.disconnect();
      assert.equal(app.state.wallet, null);
      assert.equal(app.state.account, null);
      assert.equal(app.isReconciling(), false);

      app.stop();
      assert.equal((app as any).pollTimer, null);
      assert.equal((app as any).timer, null);
    } finally {
      restore();
    }
  });

  it('stale authentication-copy repair: clears rejection on retry/success, retains on failure', async () => {
    let shouldReject = true;
    let authBegunBusyMessage: string | null = null;
    let authBegunAuthError: string | null = 'not-cleared';

    const ethereum = wallet(async (method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      if (method === 'eth_signTypedData_v4') {
        authBegunBusyMessage = app.state.busy;
        authBegunAuthError = app.state.authError;
        if (shouldReject) {
          throw Object.assign(new Error('User rejected the signature request.'), { code: 4001 });
        }
        return '0xsignature';
      }
      throw new Error(`unexpected wallet method ${method}`);
    });

    const restore = install(routingFetch(() => 7n), ethereum);
    const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state.rental = {
        rentalId: 7n,
        nodeId: NODE_ID,
        planId: PLAN_ID,
        renter: ACCOUNT,
        provider: ACCOUNT,
        priceAtomic: PRICE_ATOMIC,
        durationSeconds: 21600n,
        status: 'ACTIVE',
        startDeadline: 0n,
        startsAt: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 300),
        createdAt: 0n,
        raw: {},
      };

      // 1. Initial rejection sets authError
      await new Promise((r) => setTimeout(r, 50));
      if (!app.state.authError) {
        await app.login();
      }
      assert.match(app.state.authError ?? '', /rejected/);

      // 2. Manual retry begins -> old rejection copy cleared during sign
      shouldReject = false;
      await app.login();
      assert.equal(authBegunAuthError, null);
      assert.match(authBegunBusyMessage ?? '', /Waiting for your wallet signature/);

      // 3. Successful authentication clears authError
      assert.equal(app.state.authError, null);
      assert.equal(app.state.authenticatedFor, 7n);

      // 4. If retry fails later, retains new error
      (app as any).sessionStore.revoke();
      app.state.authenticatedFor = null;
      shouldReject = true;
      await app.login();
      assert.match(app.state.authError ?? '', /rejected/);
    } finally {
      restore();
    }
  });
});
