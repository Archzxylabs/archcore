/**
 * Controller tests for the flows the page must not get wrong.
 *
 * Every dependency here is a fake: the wallet, the RPC endpoint, and the Agent.
 * These are isolated unit tests of error and state handling. They are not a
 * wallet integration test, not a chain integration test, and not an end-to-end
 * run — no browser, no real wallet, and no operator tunnel is involved, and a
 * passing result must not be read as one.
 *
 * What they cover: a rejected wallet request, a wallet on the wrong chain, a
 * transaction whose receipt says it reverted, a refresh that replaces stale
 * chain state, a session dropped when the account changes, and an inference
 * stream aborted when the renter stops it.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { encodeAbiParameters, getFunctionSelector } from 'viem';

import { ERC20_ABI } from '../src/rentalOps.js';
import { RenterApp } from '../src/app.js';
import { CHAIN_ID_HEX } from '../src/config.js';
import { USDG_ADDRESS } from '../src/chainPure.js';
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

/** Answers the Agent's JSON routes and the chain's JSON-RPC reads. */
function routingFetch(rpcResult: (method: string, params: unknown[]) => unknown): typeof fetch {
  return mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/config')) return json(CONFIG);
    if (url.endsWith('/rental-manager.json')) return json(ABI);
    if (url.endsWith('/node')) return json({ nodeId: '1', name: 'node-1', active: true });
    if (url.endsWith('/health')) return json({ status: 'ok', checks: [{ name: 'gpu', status: 'ok' }] });
    if (url.endsWith('/gpu/status')) return json({ present: true, name: 'gpu' });
    if (url.endsWith('/auth/challenge')) {
      return json({ domain: { name: 'd' }, types: { T: [] }, primaryType: 'T', message: { rentalId: '7' } });
    }
    if (new URL(url).hostname === 'rpc.testnet.chain.robinhood.com') {
      // `fetch` normalises the URL, so the trailing slash is part of what arrives.
      const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      const result = rpcResult(body.method, body.params ?? []);
      if (result instanceof Error) {
        return json({ error: { message: result.message, code: -32000 } });
      }
      return json({ result });
    }
    return json({ error: `unhandled ${url}` }, 500);
  }) as unknown as typeof fetch;
}

const NO_RENTAL = encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [false, 0n]);
const EMPTY_NAME = `0x${'00'.repeat(32)}`;
/** `getNode`: an active node, `(nodeId, provider, name, active)`. */
const ACTIVE_NODE = encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bool' }],
  [NODE_ID, ACCOUNT, EMPTY_NAME as `0x${string}`, true],
);
/** `getListing`: an active listing, `(nodeId, paymentToken, active)`. */
const ACTIVE_LISTING = encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'address' }, { type: 'bool' }],
  [NODE_ID, CONFIG.paymentToken as `0x${string}`, true],
);

const RESERVED_RENTAL = encodeAbiParameters(
  [
    { type: 'uint256' }, // rentalId
    { type: 'uint256' }, // nodeId
    { type: 'uint8' }, // planId
    { type: 'address' }, // renter
    { type: 'address' }, // provider
    { type: 'uint256' }, // priceAtomic
    { type: 'uint256' }, // durationSeconds
    { type: 'uint8' }, // status = RESERVED (1)
    { type: 'uint256' }, // startDeadline
    { type: 'uint256' }, // startsAt
    { type: 'uint256' }, // expiresAt
    { type: 'uint256' }, // createdAt
  ],
  [
    1n,
    NODE_ID,
    PLAN_ID,
    ACCOUNT,
    ACCOUNT,
    PRICE_ATOMIC,
    21600n,
    1,
    0n,
    0n,
    0n,
    0n,
  ],
);

/** Selector → name for the ERC-20 reads a payment token answers. */
const TOKEN_READS = new Map<string, string>(
  (ERC20_ABI as unknown as { type: string; name?: string }[])
    .filter((e) => e.type === 'function')
    .map((e) => [getFunctionSelector(e as never), e.name!]),
);

/** Selector → name for every view in the artifact the controller loads. */
const VIEW_NAMES = new Map<string, string>(
  (ABI as { type: string; name?: string; stateMutability?: string }[])
    .filter((e) => e.type === 'function' && e.stateMutability === 'view')
    .map((e) => [getFunctionSelector(e as never), e.name!]),
);

/**
 * Names the view one `eth_call` payload invokes.
 *
 * Keyed on the shipped artifact this test serves, so the answers below line up
 * with the functions the controller actually encodes. Keying on selectors this
 * file made up would answer a different function than the one called.
 */
function viewOf(data: string): string {
  const name = VIEW_NAMES.get(data.slice(0, 10));
  if (!name) throw new Error(`no view in the artifact has selector ${data.slice(0, 10)}`);
  return name;
}

/**
 * The chain's answer to one `eth_call`, chosen by the function the calldata
 * names. Answering every call with the same bytes is how a test hides a reader
 * that called the wrong function.
 *
 * `afterReceipt` moves the plan's price once a transaction has landed, so a test
 * can tell a re-read after the send from the quote the page showed before it.
 */
function viewResult(data: string, { afterReceipt = false } = {}): string {
  // The payment token answers for itself. `connect` reads its decimals and symbol
  // to describe the balance, and `rent` reads balance and allowance too before it
  // asks the wallet for a signature, so a fixture silent here fails the send for
  // a reason unrelated to what these tests examine. Both cover the plan's price,
  // so no approval send appears among the sends they count.
  if (!VIEW_NAMES.has(data.slice(0, 10))) {
    const name = TOKEN_READS.get(data.slice(0, 10));
    if (!name) throw new Error(`no ERC-20 function has selector ${data.slice(0, 10)}`);
    switch (name) {
      case 'decimals':
        return encodeAbiParameters([{ type: 'uint8' }], [CONFIG.paymentDecimals]);
      case 'symbol':
        return encodeAbiParameters([{ type: 'string' }], ['USDG']);
      case 'balanceOf':
        return encodeAbiParameters([{ type: 'uint256' }], [PRICE_ATOMIC]);
      case 'allowance':
        return encodeAbiParameters([{ type: 'uint256' }], [PRICE_ATOMIC]);
      default:
        throw new Error(`unexpected token read of ${name}`);
    }
  }
  switch (viewOf(data)) {
    case 'paymentToken':
      return encodeAbiParameters([{ type: 'address' }], [CONFIG.paymentToken as `0x${string}`]);
    case 'activeRentalForNode':
      return afterReceipt
        ? encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, 1n])
        : NO_RENTAL;
    case 'getRental':
      return RESERVED_RENTAL;
    case 'getPlan':
      return encodeAbiParameters(
        [
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bool' },
          { type: 'bool' },
        ],
        [PLAN_ID, 21600n, afterReceipt ? PRICE_ATOMIC : 1n, true, false],
      );
    case 'getNode':
      return ACTIVE_NODE;
    case 'getListing':
      return ACTIVE_LISTING;
    case 'planCount':
      // One plan, listed as `getPlan(0)`. `listPlans` reads the count first and
      // then each plan, so the count is what makes the catalog non-empty.
      return encodeAbiParameters([{ type: 'uint8' }], [1]);
    default:
      throw new Error(`unexpected read of ${viewOf(data)}`);
  }
}

describe('wallet connection', { concurrency: 1 }, () => {
  it('exposes immediate feedback while the wallet approval request is pending', async () => {
    let resolveAccounts!: (accounts: unknown) => void;
    const pendingAccounts = new Promise<unknown>((resolve) => {
      resolveAccounts = resolve;
    });
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts') return pendingAccounts;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(() => '0x0'), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      const connecting = app.connect();

      assert.equal(app.state.busy, 'Connecting wallet…');
      resolveAccounts([]);
      await connecting;
      assert.match(app.state.error ?? '', /no account/i);
      assert.equal(app.state.busy, null);
    } finally {
      restore();
    }
  });

  it('reports a rejected connection instead of a connected wallet', async () => {
    const ethereum = wallet(() => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    const restore = install(routingFetch(() => '0x0'), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.connect();

      assert.equal(app.state.account, null);
      assert.equal(app.state.wallet, null);
      assert.match(app.state.error ?? '', /rejected the request/);
    } finally {
      restore();
    }
  });

  it('refuses to stay on a chain other than 46630', async () => {
    let added = false;
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') {
        // Unknown the first time, so the app adds it; still not selected after,
        // and a repeat is a plain failure rather than another "unlisted".
        if (!added) throw Object.assign(new Error('unlisted'), { code: 4902 });
        throw new Error('the wallet did not switch');
      }
      if (method === 'wallet_addEthereumChain') {
        added = true;
        return null;
      }
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(() => '0x0'), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.connect();

      assert.equal(app.state.account, null);
      assert.equal(app.state.wallet, null);
      // The wallet was asked for 46630 twice — once before the add, once after —
      // and declined the second time, so the page must say the switch failed
      // rather than show the account as connected.
      assert.match(app.state.error ?? '', /did not switch|declined the request/);
      assert.ok(ethereum.calls.includes('wallet_addEthereumChain'));
      assert.equal(ethereum.calls.filter((call) => call === 'wallet_switchEthereumChain').length, 2);
    } finally {
      restore();
    }
  });

  it('connects when the wallet is already on chain 46630', async () => {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(
      routingFetch((method, params) => {
        if (method !== 'eth_call') throw new Error(`unexpected rpc ${method}`);
        return viewResult(String((params[0] as { data?: string }).data));
      }),
      ethereum,
    );
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();

      assert.equal(app.state.account, ACCOUNT);
      assert.equal(app.state.wallet?.chainId, 46630);
      assert.equal(app.state.error, null);
    } finally {
      restore();
    }
  });

  it('carries the switched chain into state, not the pre-switch one', async () => {
    // A wallet that starts on chain 1 and accepts the switch. `connectWallet`
    // reads the chain once, before the switch: keeping that value would leave the
    // page insisting it is on chain 1 while the wallet is on 46630 — a banner
    // that never clears and a Rent button disabled for the whole session.
    let current = '0x1';
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return current;
      if (method === 'wallet_switchEthereumChain') {
        current = CHAIN_ID_HEX;
        return null;
      }
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(
      routingFetch((method, params) => {
        if (method !== 'eth_call') throw new Error(`unexpected rpc ${method}`);
        return viewResult(String((params[0] as { data?: string }).data));
      }),
      ethereum,
    );
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();

      assert.equal(app.state.account, ACCOUNT);
      assert.equal(app.state.error, null);
      // What the page renders must describe the chain the wallet ended up on,
      // which is what decides the banner and the Rent button.
      assert.equal(app.state.wallet?.chainId, 46630);
      assert.equal(app.state.wallet !== null && app.state.wallet.chainId !== 46630, false);
    } finally {
      restore();
    }
  });
});

describe('transactions', { concurrency: 1 }, () => {
  function readyApp(receipt: { status: string } | null): { app: RenterApp; restore: () => void } {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      if (method === 'eth_sendTransaction') return TX;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(
      routingFetch((method, params) => {
        if (method === 'eth_call') return viewResult(String((params[0] as { data?: string }).data));
        if (method === 'eth_getTransactionReceipt') return receipt;
        throw new Error(`unexpected rpc ${method}`);
      }),
      ethereum,
    );
    const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
    return { app, restore };
  }

  it('reports a reverted receipt and never records a completed rental', async () => {
    const { app, restore } = readyApp({ status: '0x0' });
    try {
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, quote: { nodeId: NODE_ID, planId: PLAN_ID, priceAtomic: PRICE_ATOMIC, durationSeconds: 21600n, available: true } };

      await app.rent();

      assert.match(app.state.error ?? '', /reverted/);
      assert.equal(app.state.busy, null);
      // A reverted rent leaves no rental the page could present as active.
      assert.equal(app.state.rental === null || app.state.rental.rentalId === 0n, true);
    } finally {
      restore();
    }
  });

  it('refreshes chain state after a mined transaction', async () => {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      if (method === 'eth_sendTransaction') return TX;
      throw new Error(`unexpected ${method}`);
    });
    let rented = false;
    const restore = install(
      routingFetch((method, params) => {
        if (method === 'eth_getTransactionReceipt') {
          rented = true;
          return { status: '0x1' };
        }
        if (method === 'eth_call') {
          return viewResult(String((params[0] as { data?: string }).data), { afterReceipt: rented });
        }
        throw new Error(`unexpected rpc ${method}`);
      }),
      ethereum,
    );
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      const before = app.state.quote?.priceAtomic;

      await app.rent();

      assert.equal(app.state.error, null);
      assert.equal(app.state.busy, null);
      // The quote shown after the send is the one re-read, not the one cached.
      assert.notEqual(app.state.quote?.priceAtomic, before);
      assert.equal(app.state.quote?.priceAtomic, PRICE_ATOMIC);
    } finally {
      restore();
    }
  });
});

describe('session', { concurrency: 1 }, () => {
  it('drops the session when the wallet account changes', async () => {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(
      routingFetch((_method, params) => viewResult(String((params[0] as { data?: string }).data))),
      ethereum,
    );
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, authenticatedFor: 7n };

      ethereum.emit('accountsChanged', ['0x2222222222222222222222222222222222222222']);

      assert.equal(app.state.authenticatedFor, null);
      assert.equal(app.sessionInfo(), null);
      assert.equal(app.state.account, '0x2222222222222222222222222222222222222222');
    } finally {
      restore();
    }
  });

  it('drops the session when the wallet disconnects', async () => {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(
      routingFetch((_method, params) => viewResult(String((params[0] as { data?: string }).data))),
      ethereum,
    );
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      await app.reloadConfig();
      await app.connect();
      app.state = { ...app.state, authenticatedFor: 7n };

      ethereum.emit('disconnect');

      assert.equal(app.state.account, null);
      assert.equal(app.state.authenticatedFor, null);
      assert.equal(app.sessionInfo(), null);
    } finally {
      restore();
    }
  });
});

describe('inference abort', () => {
  it('stops a running stream when the renter cancels it', async () => {
    const ethereum = wallet(() => {
      throw new Error('unused');
    });
    const restore = install(
      mock.fn(async (_input: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('event: delta\ndata: {"output":"partial"}\n\n'),
            );
            // The rest of the answer never comes. The stream ends only when the
            // renter aborts, which is the behaviour under test.
            const abort = (): void => controller.error(new DOMException('aborted', 'AbortError'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch,
      ethereum,
    );
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      const store = (app as unknown as { sessionStore: { set(s: unknown): void } }).sessionStore;
      store.set({ token: 'memory-only-token', rentalId: 7n, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      app.state = {
        ...app.state,
        rental: {
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
          createdAt: 1n,
          raw: {},
        },
      };

      const running = app.runInference('hello');
      await new Promise((resolve) => setTimeout(resolve, 20));
      app.stopInference();
      await running;

      assert.equal(app.state.streaming, false);
      assert.equal(app.state.error, null);
      const assistant = app.turns.find((turn) => turn.kind === 'assistant');
      assert.equal(assistant?.text, 'partial');
    } finally {
      restore();
    }
  });
});

describe('chat append failure', () => {
  it('records the failure instead of throwing when the transcript refuses a turn', async () => {
    const restore = install(routingFetch(() => '0x'));
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '' });
      const store = (app as unknown as { sessionStore: { set(s: unknown): void } }).sessionStore;
      store.set({ token: 'memory-only-token', rentalId: 7n, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      app.state = {
        ...app.state,
        rental: {
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
          createdAt: 1n,
          raw: {},
        },
      };
      app.bindChat({
        add() {
          throw new Error('transcript node is gone');
        },
        update() {
          return undefined;
        },
        remove() {
          return undefined;
        },
        clear() {
          return undefined;
        },
      } as unknown as import('../src/render.js').ChatView);

      await assert.doesNotReject(() => app.runInference('hello'));
      assert.match(app.state.error ?? '', /transcript could not be updated/);
      assert.equal(app.state.streaming, false);
    } finally {
      restore();
    }
  });
});


/**
 * The deep link, and what it means once the named rental has finished.
 *
 * The regression: a link to a `COMPLETED` rental was followed literally, so the
 * page showed that rental — stage `settled`, no button that follows — even
 * though the node was free. The node's own slot is the answer to "what rental
 * is in play", and the contract already says there is none, so the link is only
 * followed while the rental it names is still live.
 */
describe('deep-linked terminal rental', { concurrency: 1 }, () => {
  /** A finished rental: `COMPLETED`, which releases the node. */
  const SETTLED = encodeAbiParameters(
    [
      { type: 'uint256' }, // rentalId
      { type: 'uint256' }, // nodeId
      { type: 'uint8' }, // planId
      { type: 'address' }, // renter
      { type: 'address' }, // provider
      { type: 'uint256' }, // priceAtomic
      { type: 'uint256' }, // durationSeconds
      { type: 'uint8' }, // status = COMPLETED
      { type: 'uint256' }, // startDeadline
      { type: 'uint256' }, // startsAt
      { type: 'uint256' }, // expiresAt
      { type: 'uint256' }, // createdAt
    ],
    [7n, NODE_ID, PLAN_ID, ACCOUNT, ACCOUNT, PRICE_ATOMIC, 21600n, 3, 0n, 0n, 0n, 0n],
  );

  /** An `ACTIVE` rental that ran out, so the deep link is still the live one. */
  const EXPIRED = encodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'address' },
      { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    ],
    [7n, NODE_ID, PLAN_ID, ACCOUNT, ACCOUNT, PRICE_ATOMIC, 21600n, 2, 0n, 0n, 1n, 0n],
  );

  function viewRental(tuple: string, rented: boolean): (method: string, params: unknown[]) => unknown {
    return (method, params) => {
      if (method !== 'eth_call') throw new Error(`unexpected rpc ${method}`);
      const data = String((params[0] as { data?: string }).data);
      switch (VIEW_NAMES.get(data.slice(0, 10))) {
        case 'activeRentalForNode':
          return rented
            ? encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, 7n])
            : NO_RENTAL;
        case 'getPlan':
          return encodeAbiParameters(
            [
              { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' },
              { type: 'bool' }, { type: 'bool' },
            ],
            [PLAN_ID, 21600n, PRICE_ATOMIC, !rented, false],
          );
        case 'getNode':
          return ACTIVE_NODE;
        case 'getListing':
          return encodeAbiParameters(
            [{ type: 'uint256' }, { type: 'address' }, { type: 'bool' }],
            [NODE_ID, CONFIG.paymentToken as `0x${string}`, !rented],
          );
        case 'getRental':
          return tuple;
        default:
          // Everything else the page reads — the payment token among it — is
          // answered by the shared fixture above, and a selector its artifact
          // has no view for is the token's.
          return viewResult(data);
      }
    };
  }

  it('lets the node be rented again when the linked rental has completed', async () => {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(viewRental(SETTLED, false)), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '?rentalId=7' });
      await app.reloadConfig();
      await app.connect();

      // The node reports no live rental, and the page follows that rather than
      // the finished rental the link named.
      assert.equal(app.state.rental?.status, 'NONE');
      assert.equal(app.state.quote?.available, true);
      assert.equal(app.stage(), 'none');
      assert.equal(app.state.error, null);
    } finally {
      restore();
    }
  });

  it('still follows the link while the rental it names is live', async () => {
    const ethereum = wallet((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
      if (method === 'eth_chainId') return CHAIN_ID_HEX;
      throw new Error(`unexpected ${method}`);
    });
    const restore = install(routingFetch(viewRental(EXPIRED, true)), ethereum);
    try {
      const app = new RenterApp({ hostname: 'localhost', origin: 'http://localhost:8787', search: '?rentalId=7' });
      await app.reloadConfig();
      await app.connect();

      assert.equal(app.state.rental?.rentalId, 7n);
      assert.equal(app.state.rental?.status, 'ACTIVE');
      assert.equal(app.stage(), 'expired');
    } finally {
      restore();
    }
  });
});
