/**
 * Rental operations tests.
 *
 * Validates the normalized @archcore/chain client boundary, strict verify-response parsing,
 * all four rent eligibility predicates, USDG checks, approval flow, nonpayable rent calldata,
 * receipt verification, and network guards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  custom,
  defineChain,
  encodeAbiParameters,
  getFunctionSelector,
} from 'viem';

import {
  RentalManagerClient,
  ERC20_ABI,
  areAddressesEqual,
  StatusMapper,
  type EncodedTransactionRequest,
} from '@archcore/chain';
import { CHAIN_ID_HEX } from '../src/config.js';
import {
  CHAIN_ID,
  DEMO_NODE_ID,
  USDG_ADDRESS,
  USDG_DECIMALS_EXPECTED,
  USDG_SYMBOL,
} from '../src/chainPure.js';
import {
  cancelExpiredReservation,
  RentalOpsError,
  RentalReader,
  readPaymentToken,
  rent,
  settleAfterExpiry,
  statusMapper,
  toZeroHexValue,
} from '../src/rentalOps.js';
import { emptyRental } from '../src/rentalState.js';
import { AgentError, parseSession } from '../src/agentClient.js';
import { WalletError, type Eip1193Provider } from '../src/wallet.js';

const abi = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../packages/abi/RentalManager.json', import.meta.url)), 'utf8'),
) as Array<{ type: string; name?: string; stateMutability?: string }>;

const MANAGER = '0x5555555555555555555555555555555555555555';
const RENTER = '0x1111111111111111111111111111111111111111';
const PROVIDER = '0x3333333333333333333333333333333333333333';
const EMPTY_NAME = `0x${'00'.repeat(32)}`;

const PLAN_ID = 1;
const PLAN_PRICE_ATOMIC = 6_000_000n;
const PLAN_DURATION_SECONDS = 21600n;

const SELECTORS = new Map<string, string>(
  abi
    .filter((e) => e.type === 'function')
    .map((e) => [getFunctionSelector(e as never), e.name!]),
);

const ERC20_SELECTORS = new Map<string, string>(
  (ERC20_ABI as unknown as Array<{ type: string; name?: string }>).map((e) => [
    getFunctionSelector(e as never),
    e.name!,
  ]),
);

function planTuple(
  planId: number,
  durationSeconds: bigint,
  priceAtomic: bigint,
  active = true,
  demoOnly = false,
) {
  return [BigInt(planId), durationSeconds, priceAtomic, active, demoOnly] as const;
}

const PAID_PLAN = planTuple(PLAN_ID, PLAN_DURATION_SECONDS, PLAN_PRICE_ATOMIC, true, false);
const DEMO_PLAN = planTuple(0, 300n, 100_000n, true, true);
const ACTIVE_NODE = [1n, PROVIDER, EMPTY_NAME, true] as const;
const ACTIVE_LISTING = [1n, USDG_ADDRESS, true] as const;

const RENTAL_TUPLE = [
  7n,
  1n,
  BigInt(PLAN_ID),
  RENTER,
  PROVIDER,
  PLAN_PRICE_ATOMIC,
  PLAN_DURATION_SECONDS,
  2, // status = ACTIVE
  1_700_000_600n,
  1_700_000_100n,
  1_700_003_600n,
  1_700_000_000n,
] as const;

function encodeAnswer(value: unknown): string {
  if (Array.isArray(value)) {
    const types = value.map((v) => {
      if (typeof v === 'bigint') return { type: 'uint256' };
      if (typeof v === 'number') return { type: 'uint8' };
      if (typeof v === 'boolean') return { type: 'bool' };
      if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) return { type: 'bytes32' };
      return { type: 'address' };
    });
    return encodeAbiParameters(types as never, value as never);
  }
  if (typeof value === 'boolean') return encodeAbiParameters([{ type: 'bool' }], [value]);
  if (typeof value === 'string') {
    if (value.startsWith('0x') && value.length === 42) {
      return encodeAbiParameters([{ type: 'address' }], [value as `0x${string}`]);
    }
    if (value.startsWith('0x') && value.length === 66) {
      return encodeAbiParameters([{ type: 'bytes32' }], [value as `0x${string}`]);
    }
    return encodeAbiParameters([{ type: 'string' }], [value]);
  }
  if (typeof value === 'number') return encodeAbiParameters([{ type: 'uint8' }], [value]);
  return encodeAbiParameters([{ type: 'uint256' }], [BigInt(String(value))]);
}

interface TestRpcAnswers {
  manager?: Record<string, unknown>;
  token?: {
    decimals?: number;
    symbol?: string;
    balance?: bigint;
    allowance?: bigint | (() => bigint);
  };
  receipts?: Record<string, '0x1' | '0x0'>;
  onReceipt?: () => void;
}

function createTestClient(answers: TestRpcAnswers, overrides?: { calls?: string[] }) {
  const calls = overrides?.calls ?? [];
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.example'] } },
  });

  const transport = custom({
    request: async ({ method, params }) => {
      if (method === 'eth_call') {
        const [call] = params as [{ to: string; data: string }];
        const to = call.to.toLowerCase();
        const data = call.data;
        const selector = data.slice(0, 10);

        if (areAddressesEqual(to, USDG_ADDRESS)) {
          const fn = ERC20_SELECTORS.get(selector);
          calls.push(`token:${fn}`);
          if (fn === 'decimals') return encodeAnswer(answers.token?.decimals ?? USDG_DECIMALS_EXPECTED);
          if (fn === 'symbol') return encodeAnswer(answers.token?.symbol ?? USDG_SYMBOL);
          if (fn === 'balanceOf') return encodeAnswer(answers.token?.balance ?? PLAN_PRICE_ATOMIC);
          if (fn === 'allowance') {
            const raw = answers.token?.allowance;
            const val = typeof raw === 'function' ? raw() : (raw ?? PLAN_PRICE_ATOMIC);
            return encodeAnswer(val);
          }
          throw new Error(`Unexpected token call: ${fn ?? selector}`);
        }

        const fn = SELECTORS.get(selector);
        calls.push(`manager:${fn}`);
        if (fn && answers.manager && fn in answers.manager) {
          const ans = answers.manager[fn];
          if (ans instanceof Error) throw ans;
          if (typeof ans === 'function') {
            return encodeAnswer(ans(data));
          }
          return encodeAnswer(ans);
        }
        throw new Error(`Unexpected manager call: ${fn ?? selector}`);
      }

      if (method === 'eth_getTransactionReceipt') {
        answers.onReceipt?.();
        const [hash] = params as [string];
        const status = answers.receipts?.[hash] ?? '0x1';
        return {
          status,
          transactionHash: hash,
          blockNumber: '0x1',
          blockHash: `0x${'12'.repeat(32)}`,
          transactionIndex: '0x0',
          from: RENTER,
          to: MANAGER,
          gasUsed: '0x5208',
          cumulativeGasUsed: '0x5208',
          effectiveGasPrice: '0x3b9aca00',
          logs: [],
        };
      }

      throw new Error(`Unhandled RPC method: ${method}`);
    },
  });

  const publicClientOverride = createPublicClient({ chain, transport });
  return RentalManagerClient.create({
    chainId: CHAIN_ID,
    rpcUrl: 'https://rpc.example',
    rentalManagerAddress: MANAGER,
    paymentTokenAddress: USDG_ADDRESS,
    nodeId: DEMO_NODE_ID,
    publicClientOverride,
  });
}

function walletOn(
  chainIdHex: string,
  {
    switchTo,
    add,
    onSend,
  }: {
    switchTo?: () => string;
    add?: () => void;
    onSend?: (params: { to: string; data: string; value: string }) => void;
  } = {},
) {
  const calls: string[] = [];
  const sentTxs: Array<{ to: string; data: string; value: string }> = [];
  let current = chainIdHex;
  let known = add === undefined;
  const provider: Eip1193Provider & {
    calls: string[];
    sentTxs: Array<{ to: string; data: string; value: string }>;
  } = {
    calls,
    sentTxs,
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === 'eth_chainId') return current;
      if (method === 'eth_accounts') return [RENTER];
      if (method === 'wallet_addEthereumChain') {
        add?.();
        known = true;
        return null;
      }
      if (method === 'wallet_switchEthereumChain') {
        if (!known || switchTo === undefined) {
          throw Object.assign(new Error('Wallet rejected switch.'), { code: known ? 4901 : 4902 });
        }
        current = switchTo();
        return null;
      }
      if (method === 'eth_sendTransaction') {
        const [tx] = params as [{ to: string; data: string; value: string }];
        sentTxs.push(tx);
        onSend?.(tx);
        return `0x${'aa'.repeat(32)}`;
      }
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  return provider;
}

describe('RentalReader with normalized @archcore/chain client', () => {
  it('reads plan catalog using planCount and getPlan', async () => {
    const client = createTestClient({
      manager: {
        planCount: 2,
        getPlan: (data: string) => (data.endsWith('00') ? DEMO_PLAN : PAID_PLAN),
      },
    });
    const reader = new RentalReader(client);
    assert.equal(await reader.planCount(), 2);
    const plans = await reader.listPlans();
    assert.equal(plans.length, 2);
    assert.equal(plans[0].planId, 0);
    assert.equal(plans[0].demoOnly, true);
    assert.equal(plans[1].planId, 1);
    assert.equal(plans[1].priceAtomic, PLAN_PRICE_ATOMIC);
  });

  it('reads normalized getNode and getListing', async () => {
    const client = createTestClient({
      manager: {
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
      },
    });
    const reader = new RentalReader(client);
    const node = await reader.getNode(1n);
    assert.equal(node.nodeId, 1n);
    assert.equal(node.active, true);
    assert.equal(areAddressesEqual(node.provider, PROVIDER), true);

    const listing = await reader.getListing(1n);
    assert.equal(listing.nodeId, 1n);
    assert.equal(listing.active, true);
    assert.equal(areAddressesEqual(listing.paymentToken, USDG_ADDRESS), true);
  });

  it('reads activeRentalForNode returning normalized ChainRental when live', async () => {
    const client = createTestClient({
      manager: {
        activeRentalForNode: [true, 7n],
        getRental: RENTAL_TUPLE,
      },
    });
    const reader = new RentalReader(client);
    const rental = await reader.getActiveRentalForNode(1n);
    assert.equal(rental.rentalId, 7n);
    assert.equal(rental.status, 'ACTIVE');
    assert.equal(rental.priceAtomic, PLAN_PRICE_ATOMIC);
    assert.equal(await reader.nodeIsRented(1n), true);
  });

  it('reads activeRentalForNode returning emptyRental when idle (false, 0)', async () => {
    const client = createTestClient({
      manager: {
        activeRentalForNode: [false, 0n],
      },
    });
    const reader = new RentalReader(client);
    const rental = await reader.getActiveRentalForNode(1n);
    assert.deepEqual(rental, emptyRental());
    assert.equal(await reader.nodeIsRented(1n), false);
  });
});

describe('all four rent eligibility predicates', () => {
  function makeQuoteClient(overrides: {
    nodeActive?: boolean;
    listingActive?: boolean;
    rented?: boolean;
    planActive?: boolean;
  }) {
    return createTestClient({
      manager: {
        getNode: [1n, PROVIDER, EMPTY_NAME, overrides.nodeActive ?? true],
        getListing: [1n, USDG_ADDRESS, overrides.listingActive ?? true],
        activeRentalForNode: [overrides.rented ?? false, overrides.rented ? 7n : 0n],
        getRental: RENTAL_TUPLE,
        getPlan: planTuple(
          PLAN_ID,
          PLAN_DURATION_SECONDS,
          PLAN_PRICE_ATOMIC,
          overrides.planActive ?? true,
          false,
        ),
      },
    });
  }

  it('passes all four predicates when node, listing, and plan are active and node is free', async () => {
    const client = makeQuoteClient({});
    const reader = new RentalReader(client);
    const rentable = await reader.isNodeRentable(1n, PLAN_ID);
    assert.equal(rentable.eligible, true);

    const quote = await reader.quoteRent(1n, PLAN_ID);
    assert.equal(quote.available, true);
    assert.equal(quote.priceAtomic, PLAN_PRICE_ATOMIC);
  });

  it('fails predicate 1 when node is inactive', async () => {
    const client = makeQuoteClient({ nodeActive: false });
    const reader = new RentalReader(client);
    const rentable = await reader.isNodeRentable(1n, PLAN_ID);
    assert.equal(rentable.eligible, false);
    assert.match(rentable.reason ?? '', /inactive/i);

    const quote = await reader.quoteRent(1n, PLAN_ID);
    assert.equal(quote.available, false);
  });

  it('fails predicate 2 when listing is inactive', async () => {
    const client = makeQuoteClient({ listingActive: false });
    const reader = new RentalReader(client);
    const rentable = await reader.isNodeRentable(1n, PLAN_ID);
    assert.equal(rentable.eligible, false);
    assert.match(rentable.reason ?? '', /inactive/i);

    const quote = await reader.quoteRent(1n, PLAN_ID);
    assert.equal(quote.available, false);
  });

  it('fails predicate 3 when node already holds an active rental', async () => {
    const client = makeQuoteClient({ rented: true });
    const reader = new RentalReader(client);
    const rentable = await reader.isNodeRentable(1n, PLAN_ID);
    assert.equal(rentable.eligible, false);
    assert.match(rentable.reason ?? '', /already has/i);

    const quote = await reader.quoteRent(1n, PLAN_ID);
    assert.equal(quote.available, false);
  });

  it('fails predicate 4 when chosen plan is inactive', async () => {
    const client = makeQuoteClient({ planActive: false });
    const reader = new RentalReader(client);
    const rentable = await reader.isNodeRentable(1n, PLAN_ID);
    assert.equal(rentable.eligible, false);
    assert.match(rentable.reason ?? '', /inactive/i);

    const quote = await reader.quoteRent(1n, PLAN_ID);
    assert.equal(quote.available, false);
  });
});

describe('fail closed on malformed or RPC-failed chain reads', () => {
  it('fails closed when getNode RPC fails', async () => {
    const client = createTestClient({
      manager: {
        getNode: new Error('Node RPC timeout'),
      },
    });
    const reader = new RentalReader(client);
    await assert.rejects(reader.getNode(1n), RentalOpsError);
  });

  it('fails closed when getListing RPC fails', async () => {
    const client = createTestClient({
      manager: {
        getListing: new Error('Listing RPC down'),
      },
    });
    const reader = new RentalReader(client);
    await assert.rejects(reader.getListing(1n), RentalOpsError);
  });

  it('fails closed when activeRentalForNode returns contradictory tuple (false, 7)', async () => {
    const client = createTestClient({
      manager: {
        activeRentalForNode: [false, 7n],
      },
    });
    const reader = new RentalReader(client);
    await assert.rejects(reader.getActiveRentalForNode(1n), /contradictory/i);
  });

  it('fails closed when activeRentalForNode returns contradictory tuple (true, 0)', async () => {
    const client = createTestClient({
      manager: {
        activeRentalForNode: [true, 0n],
      },
    });
    const reader = new RentalReader(client);
    await assert.rejects(reader.getActiveRentalForNode(1n), /contradictory/i);
  });

  it('fails closed when readPaymentToken fails', async () => {
    // Corrupt transport by overriding paymentToken to throw
    const errorClient = createTestClient({
      manager: {
        paymentToken: new Error('Token RPC offline'),
      },
    });
    await assert.rejects(readPaymentToken(errorClient, RENTER), RentalOpsError);
  });
});

describe('USDG address, decimals, balance, and allowance', () => {
  const DEFAULT_ANSWERS = {
    paymentToken: USDG_ADDRESS,
    getNode: ACTIVE_NODE,
    getListing: ACTIVE_LISTING,
    activeRentalForNode: [false, 0n],
    getPlan: PAID_PLAN,
  };

  const QUOTE = {
    nodeId: 1n,
    planId: PLAN_ID,
    priceAtomic: PLAN_PRICE_ATOMIC,
    durationSeconds: PLAN_DURATION_SECONDS,
    available: true,
  };

  it('reads payment token metadata, balance, and allowance correctly', async () => {
    const client = createTestClient({
      manager: DEFAULT_ANSWERS,
      token: {
        decimals: 6,
        symbol: 'USDG',
        balance: 10_000_000n,
        allowance: 8_000_000n,
      },
    });
    const tokenView = await readPaymentToken(client, RENTER, USDG_ADDRESS, MANAGER);
    assert.equal(areAddressesEqual(tokenView.address, USDG_ADDRESS), true);
    assert.equal(tokenView.decimals, 6);
    assert.equal(tokenView.symbol, 'USDG');
    assert.equal(tokenView.balance, 10_000_000n);
    assert.equal(tokenView.allowance, 8_000_000n);
  });

  it('rejects rent if payment token address does not equal frozen USDG address', async () => {
    const WRONG_TOKEN = '0x1234567890123456789012345678901234567890';
    const client = createTestClient({
      manager: { ...DEFAULT_ANSWERS, paymentToken: WRONG_TOKEN },
    });
    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      /does not match expected frozen USDG address/i,
    );
  });

  it('rejects rent if token decimals is not 6', async () => {
    const client = createTestClient({
      manager: DEFAULT_ANSWERS,
      token: { decimals: 18, symbol: 'USDG' },
    });
    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      /decimals mismatch: expected 6, observed 18/i,
    );
  });

  it('rejects rent if renter balance is less than required priceAtomic', async () => {
    const client = createTestClient({
      manager: DEFAULT_ANSWERS,
      token: { balance: PLAN_PRICE_ATOMIC - 1n },
    });
    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      /needs.*but the wallet holds/i,
    );
  });
});

function spyMethod<T extends object, K extends keyof T>(
  target: T,
  methodName: K,
): { calls: Array<{ args: unknown[]; result: unknown }> } {
  const original = (target[methodName] as (...args: unknown[]) => unknown).bind(target);
  const calls: Array<{ args: unknown[]; result: unknown }> = [];
  (target as any)[methodName] = (...args: unknown[]) => {
    const result = original(...args);
    calls.push({ args, result });
    return result;
  };
  return { calls };
}

describe('exact approval amount and successful approval receipt', () => {
  const RESERVED_RENTAL = [
    1n, // rentalId
    1n, // nodeId
    BigInt(PLAN_ID),
    RENTER,
    PROVIDER,
    PLAN_PRICE_ATOMIC,
    PLAN_DURATION_SECONDS,
    1, // status = RESERVED
    1_700_000_600n,
    0n,
    0n,
    1_700_000_000n,
  ] as const;

  const QUOTE = {
    nodeId: 1n,
    planId: PLAN_ID,
    priceAtomic: PLAN_PRICE_ATOMIC,
    durationSeconds: PLAN_DURATION_SECONDS,
    available: true,
  };

  it('sends approval for EXACTLY selectedPlan.priceAtomic when allowance is short, forwarding calldata unchanged and rereading', async () => {
    let allowanceReadCount = 0;
    let postRent = false;

    const client = createTestClient({
      manager: {
        paymentToken: USDG_ADDRESS,
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
        activeRentalForNode: () => (postRent ? [true, 1n] : [false, 0n]),
        getRental: RESERVED_RENTAL,
        getPlan: PAID_PLAN,
      },
      token: {
        balance: 10_000_000n,
        // Short on initial read, covered on post-approval read
        allowance: () => {
          allowanceReadCount += 1;
          return allowanceReadCount > 1 ? PLAN_PRICE_ATOMIC : 0n;
        },
      },
    });

    const approveSpy = spyMethod(client, 'encodeApproveCalldata');

    const wallet = walletOn(CHAIN_ID_HEX, {
      onSend: (tx) => {
        if (areAddressesEqual(tx.to, MANAGER)) {
          postRent = true;
        }
      },
    });

    const outcome = await rent(wallet, client, QUOTE, RENTER);
    assert.ok(outcome.hash.startsWith('0x'));

    // Two sends: approve, then rent
    assert.equal(wallet.sentTxs.length, 2);

    // 1. Web invokes client.encodeApproveCalldata
    assert.equal(approveSpy.calls.length, 1);
    const [spenderArg, amountArg, tokenArg] = approveSpy.calls[0].args;
    assert.equal(areAddressesEqual(spenderArg as string, MANAGER), true);
    // Encoded amount is exactly the selected plan's priceAtomic
    assert.equal(amountArg, PLAN_PRICE_ATOMIC);
    assert.equal(areAddressesEqual(tokenArg as string, USDG_ADDRESS), true);

    const approveResult = approveSpy.calls[0].result as EncodedTransactionRequest;
    assert.equal(approveResult.value, 0n);

    // 2. Returned to and data are sent to the wallet unchanged with zero native value
    const approveTx = wallet.sentTxs[0];
    assert.equal(approveTx.to, approveResult.to);
    assert.equal(approveTx.data, approveResult.data);
    assert.equal(approveTx.value, '0x0');

    // 3. Existing approval receipt and allowance reread behavior remains intact
    assert.ok(allowanceReadCount >= 3);
  });

  it('fails closed when approval transaction reverts', async () => {
    const client = createTestClient({
      manager: {
        paymentToken: USDG_ADDRESS,
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
        activeRentalForNode: [false, 0n],
        getPlan: PAID_PLAN,
      },
      token: {
        balance: 10_000_000n,
        allowance: 0n,
      },
      receipts: {
        [`0x${'aa'.repeat(32)}`]: '0x0', // Approval reverts
      },
    });

    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      /approval reverted or failed/i,
    );
    // Only approval attempted; rent was never sent
    assert.equal(wallet.sentTxs.length, 1);
  });
});

describe('nonpayable rent calldata and zero ETH value', () => {
  const RESERVED_RENTAL = [
    1n,
    1n,
    BigInt(PLAN_ID),
    RENTER,
    PROVIDER,
    PLAN_PRICE_ATOMIC,
    PLAN_DURATION_SECONDS,
    1,
    1_700_000_600n,
    0n,
    0n,
    1_700_000_000n,
  ] as const;

  const QUOTE = {
    nodeId: 1n,
    planId: PLAN_ID,
    priceAtomic: PLAN_PRICE_ATOMIC,
    durationSeconds: PLAN_DURATION_SECONDS,
    available: true,
  };

  it('invokes client.encodeRentCalldata and forwards returned to and data unchanged with zero native value', async () => {
    let postRent = false;
    const client = createTestClient({
      manager: {
        paymentToken: USDG_ADDRESS,
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
        activeRentalForNode: () => (postRent ? [true, 1n] : [false, 0n]),
        getRental: RESERVED_RENTAL,
        getPlan: PAID_PLAN,
      },
    });

    const rentSpy = spyMethod(client, 'encodeRentCalldata');

    const wallet = walletOn(CHAIN_ID_HEX, {
      onSend: () => {
        postRent = true;
      },
    });

    const outcome = await rent(wallet, client, QUOTE, RENTER);
    assert.ok(outcome.hash.startsWith('0x'));

    assert.equal(wallet.sentTxs.length, 1);

    // 1. Web invokes client.encodeRentCalldata(nodeId, planId)
    assert.equal(rentSpy.calls.length, 1);
    const [nodeIdArg, planIdArg] = rentSpy.calls[0].args;
    assert.equal(nodeIdArg, 1n);
    assert.equal(planIdArg, PLAN_ID);

    const rentResult = rentSpy.calls[0].result as EncodedTransactionRequest;
    assert.equal(rentResult.value, 0n);

    // 2. The returned to and data are sent unchanged with zero native value
    const rentTx = wallet.sentTxs[0];
    assert.equal(rentTx.to, rentResult.to);
    assert.equal(rentTx.data, rentResult.data);
    assert.equal(rentTx.value, '0x0');
  });
});

describe('successful rent receipt plus fresh chain reread', () => {
  const QUOTE = {
    nodeId: 1n,
    planId: PLAN_ID,
    priceAtomic: PLAN_PRICE_ATOMIC,
    durationSeconds: PLAN_DURATION_SECONDS,
    available: true,
  };

  it('fails closed when rent transaction reverts onchain', async () => {
    const client = createTestClient({
      manager: {
        paymentToken: USDG_ADDRESS,
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
        activeRentalForNode: [false, 0n],
        getPlan: PAID_PLAN,
      },
      receipts: {
        [`0x${'aa'.repeat(32)}`]: '0x0', // Rent reverts
      },
    });

    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      /rent\(\) reverted or failed/i,
    );
  });

  it('fails closed when fresh chain reread after receipt is NOT RESERVED', async () => {
    const client = createTestClient({
      manager: {
        paymentToken: USDG_ADDRESS,
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
        activeRentalForNode: [false, 0n], // Stale or contradictory read
        getPlan: PAID_PLAN,
      },
    });

    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      /fresh reservation could not be verified/i,
    );
  });
});

describe('cancelExpiredReservation and settleAfterExpiry', () => {
  it('invokes client.encodeCancelExpiredReservationCalldata and forwards to/data unchanged with zero value', async () => {
    const client = createTestClient({
      manager: {},
    });
    const cancelSpy = spyMethod(client, 'encodeCancelExpiredReservationCalldata');

    const wallet = walletOn(CHAIN_ID_HEX);
    const hash = await cancelExpiredReservation(wallet, client, 7n);
    assert.ok(hash.startsWith('0x'));

    // 1. Web invokes client.encodeCancelExpiredReservationCalldata(rentalId)
    assert.equal(cancelSpy.calls.length, 1);
    assert.equal(cancelSpy.calls[0].args[0], 7n);

    const cancelResult = cancelSpy.calls[0].result as EncodedTransactionRequest;
    assert.equal(cancelResult.value, 0n);

    // 2. Returned to and data are sent unchanged with zero native value
    assert.equal(wallet.sentTxs.length, 1);
    const tx = wallet.sentTxs[0];
    assert.equal(tx.to, cancelResult.to);
    assert.equal(tx.data, cancelResult.data);
    assert.equal(tx.value, '0x0');
  });

  it('fails when cancel reverts', async () => {
    const client = createTestClient({
      manager: {},
      receipts: { [`0x${'aa'.repeat(32)}`]: '0x0' },
    });
    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(cancelExpiredReservation(wallet, client, 7n), RentalOpsError);
  });

  it('invokes client.encodeSettleAfterExpiryCalldata and forwards to/data unchanged with zero value', async () => {
    const client = createTestClient({
      manager: {},
    });
    const settleSpy = spyMethod(client, 'encodeSettleAfterExpiryCalldata');

    const wallet = walletOn(CHAIN_ID_HEX);
    const hash = await settleAfterExpiry(wallet, client, 7n);
    assert.ok(hash.startsWith('0x'));

    // 1. Web invokes client.encodeSettleAfterExpiryCalldata(rentalId)
    assert.equal(settleSpy.calls.length, 1);
    assert.equal(settleSpy.calls[0].args[0], 7n);

    const settleResult = settleSpy.calls[0].result as EncodedTransactionRequest;
    assert.equal(settleResult.value, 0n);

    // 2. Returned to and data are sent unchanged with zero native value
    assert.equal(wallet.sentTxs.length, 1);
    const tx = wallet.sentTxs[0];
    assert.equal(tx.to, settleResult.to);
    assert.equal(tx.data, settleResult.data);
    assert.equal(tx.value, '0x0');
  });

  it('fails when settle reverts', async () => {
    const client = createTestClient({
      manager: {},
      receipts: { [`0x${'aa'.repeat(32)}`]: '0x0' },
    });
    const wallet = walletOn(CHAIN_ID_HEX);
    await assert.rejects(settleAfterExpiry(wallet, client, 7n), RentalOpsError);
  });
});

describe('chain guard on every send', () => {
  const RESERVED_RENTAL = [
    1n,
    1n,
    BigInt(PLAN_ID),
    RENTER,
    PROVIDER,
    PLAN_PRICE_ATOMIC,
    PLAN_DURATION_SECONDS,
    1,
    1_700_000_600n,
    0n,
    0n,
    1_700_000_000n,
  ] as const;

  const QUOTE = {
    nodeId: 1n,
    planId: PLAN_ID,
    priceAtomic: PLAN_PRICE_ATOMIC,
    durationSeconds: PLAN_DURATION_SECONDS,
    available: true,
  };

  function createGuardClient() {
    let postRent = false;
    return createTestClient({
      manager: {
        paymentToken: USDG_ADDRESS,
        getNode: ACTIVE_NODE,
        getListing: ACTIVE_LISTING,
        activeRentalForNode: () => (postRent ? [true, 1n] : [false, 0n]),
        getRental: RESERVED_RENTAL,
        getPlan: PAID_PLAN,
      },
      onReceipt: () => {
        postRent = true;
      },
    });
  }

  it('switches the wallet to 46630 before rent is sent', async () => {
    const wallet = walletOn('0x1', { switchTo: () => CHAIN_ID_HEX });
    const client = createGuardClient();
    const outcome = await rent(wallet, client, QUOTE, RENTER);
    assert.ok(outcome.hash.startsWith('0x'));
    assert.deepEqual(wallet.calls, [
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'eth_chainId',
      'eth_accounts',
      'eth_sendTransaction',
    ]);
  });

  it('rechecks the chain and account immediately before send', async () => {
    const wallet = walletOn(CHAIN_ID_HEX);
    const client = createGuardClient();
    await rent(wallet, client, QUOTE, RENTER);
    assert.deepEqual(wallet.calls, ['eth_chainId', 'eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  });

  it('adds the chain when the wallet reports it as unlisted, then sends', async () => {
    let listed = false;
    const wallet = walletOn('0x1', {
      switchTo: () => CHAIN_ID_HEX,
      add: () => {
        listed = true;
      },
    });
    assert.equal(listed, false);
    const client = createGuardClient();
    await rent(wallet, client, QUOTE, RENTER);
    assert.ok(wallet.calls.includes('wallet_addEthereumChain'));
    assert.equal(wallet.calls.filter((call) => call === 'wallet_switchEthereumChain').length, 2);
    assert.ok(wallet.calls.includes('eth_sendTransaction'));
  });

  it('refuses to send rent when the wallet cannot be moved to 46630', async () => {
    const wallet = walletOn('0x1');
    const client = createGuardClient();
    await assert.rejects(
      rent(wallet, client, QUOTE, RENTER),
      (error: unknown) => error instanceof WalletError,
    );
    assert.equal(wallet.calls.includes('eth_sendTransaction'), false);
  });

  it('refuses an unavailable node before it touches the wallet', async () => {
    const wallet = walletOn('0x1');
    const client = createGuardClient();
    await assert.rejects(
      rent(wallet, client, { ...QUOTE, available: false }, RENTER),
      /not available for rent/i,
    );
    assert.deepEqual(wallet.calls, []);
  });

  it('guards cancelExpiredReservation to 46630', async () => {
    const wallet = walletOn('0x1', { switchTo: () => CHAIN_ID_HEX });
    const client = createGuardClient();
    await cancelExpiredReservation(wallet, client, 7n);
    assert.ok(wallet.calls.indexOf('wallet_switchEthereumChain') < wallet.calls.indexOf('eth_sendTransaction'));

    const stranded = walletOn('0x1');
    await assert.rejects(cancelExpiredReservation(stranded, client, 7n), WalletError);
    assert.equal(stranded.calls.includes('eth_sendTransaction'), false);
  });

  it('guards settleAfterExpiry to 46630', async () => {
    const wallet = walletOn('0x1', { switchTo: () => CHAIN_ID_HEX });
    const client = createGuardClient();
    await settleAfterExpiry(wallet, client, 7n);
    assert.ok(wallet.calls.indexOf('wallet_switchEthereumChain') < wallet.calls.indexOf('eth_sendTransaction'));

    const stranded = walletOn('0x1');
    await assert.rejects(settleAfterExpiry(stranded, client, 7n), WalletError);
    assert.equal(stranded.calls.includes('eth_sendTransaction'), false);
  });
});

describe('statusMapper', () => {
  it('maps contract status codes to names', () => {
    assert.equal(statusMapper.fromChain(0n), 'NONE');
    assert.equal(statusMapper.fromChain(1n), 'RESERVED');
    assert.equal(statusMapper.fromChain(2n), 'ACTIVE');
  });

  it('throws on an undefined status code', () => {
    assert.throws(() => statusMapper.fromChain(99n));
  });

  it('is the same StatusMapper class exported by @archcore/chain', () => {
    assert.ok(statusMapper instanceof StatusMapper);
  });
});

describe('strict POST /auth/verify parsing (parseSession)', () => {
  it('parses canonical ledger response successfully', () => {
    const parsed = parseSession({
      token: 'opaque-token-12345',
      rentalId: '7',
      expiresAt: '1790000000',
    });
    assert.equal(parsed.token, 'opaque-token-12345');
    assert.equal(parsed.rentalId, 7n);
    assert.equal(parsed.expiresAt, 1790000000);
  });

  it('rejects sessionToken alias', () => {
    assert.throws(
      () =>
        parseSession({
          sessionToken: 'opaque-token',
          rentalId: '7',
          expiresAt: '1790000000',
        }),
      (err: unknown) => err instanceof AgentError && /unexpected fields: sessionToken/i.test(err.message),
    );
  });

  it('rejects numeric rentalId', () => {
    assert.throws(
      () =>
        parseSession({
          token: 'opaque-token',
          rentalId: 7,
          expiresAt: '1790000000',
        }),
      (err: unknown) => err instanceof AgentError && /numeric or non-string rentalId/i.test(err.message),
    );
  });

  it('rejects numeric expiresAt', () => {
    assert.throws(
      () =>
        parseSession({
          token: 'opaque-token',
          rentalId: '7',
          expiresAt: 1790000000,
        }),
      (err: unknown) => err instanceof AgentError && /numeric or non-string expiresAt/i.test(err.message),
    );
  });

  it('rejects millisecond timestamp / milliseconds guessing', () => {
    assert.throws(
      () =>
        parseSession({
          token: 'opaque-token',
          rentalId: '7',
          expiresAt: '1790000000000',
        }),
      (err: unknown) => err instanceof AgentError && /millisecond timestamp/i.test(err.message),
    );
  });

  it('rejects missing token', () => {
    assert.throws(
      () =>
        parseSession({
          rentalId: '7',
          expiresAt: '1790000000',
        }),
      (err: unknown) => err instanceof AgentError && /missing required field: token/i.test(err.message),
    );
  });

  it('rejects empty token', () => {
    assert.throws(
      () =>
        parseSession({
          token: '   ',
          rentalId: '7',
          expiresAt: '1790000000',
        }),
      (err: unknown) => err instanceof AgentError && /invalid or empty token/i.test(err.message),
    );
  });

  it('rejects missing rentalId', () => {
    assert.throws(
      () =>
        parseSession({
          token: 'opaque-token',
          expiresAt: '1790000000',
        }),
      (err: unknown) => err instanceof AgentError && /missing required field: rentalId/i.test(err.message),
    );
  });

  it('rejects missing expiresAt', () => {
    assert.throws(
      () =>
        parseSession({
          token: 'opaque-token',
          rentalId: '7',
        }),
      (err: unknown) => err instanceof AgentError && /missing required field: expiresAt/i.test(err.message),
    );
  });

  it('rejects malformed rentalId (non-digit or float or zero)', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '1.5', expiresAt: '1790000000' }),
      AgentError,
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '-5', expiresAt: '1790000000' }),
      AgentError,
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '0', expiresAt: '1790000000' }),
      AgentError,
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: 'abc', expiresAt: '1790000000' }),
      AgentError,
    );
  });

  it('rejects malformed expiresAt (non-digit or zero or negative)', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '1790000.5' }),
      AgentError,
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '0' }),
      AgentError,
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '-100' }),
      AgentError,
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: 'never' }),
      AgentError,
    );
  });

  it('rejects unexpected extra schema fields', () => {
    assert.throws(
      () =>
        parseSession({
          token: 'opaque-token',
          rentalId: '7',
          expiresAt: '1790000000',
          unexpected: true,
        }),
      (err: unknown) => err instanceof AgentError && /unexpected fields: unexpected/i.test(err.message),
    );
  });

  it('rejects non-object payloads', () => {
    assert.throws(() => parseSession(null), AgentError);
    assert.throws(() => parseSession([]), AgentError);
    assert.throws(() => parseSession('string'), AgentError);
    assert.throws(() => parseSession(123), AgentError);
  });
});

describe('toZeroHexValue safe zero-value conversion', () => {
  it('converts 0n to exact hex quantity 0x0', () => {
    assert.equal(toZeroHexValue(0n), '0x0');
  });

  it('rejects positive value and cannot produce nonzero hex value', () => {
    assert.throws(
      () => toZeroHexValue(1n),
      (err: unknown) => err instanceof RentalOpsError && /requires zero native value/i.test((err as Error).message),
    );
    assert.throws(
      () => toZeroHexValue(100_000n),
      (err: unknown) => err instanceof RentalOpsError && /requires zero native value/i.test((err as Error).message),
    );
  });

  it('rejects negative value and cannot produce nonzero hex value', () => {
    assert.throws(
      () => toZeroHexValue(-1n),
      (err: unknown) => err instanceof RentalOpsError && /requires zero native value/i.test((err as Error).message),
    );
  });
});

describe('static source-level boundary verification', () => {
  const sourcePath = fileURLToPath(new URL('../src/rentalOps.ts', import.meta.url));
  const sourceContent = readFileSync(sourcePath, 'utf8');

  it('proves apps/web/src/rentalOps.ts does not import or call encodeFunctionData', () => {
    assert.equal(
      sourceContent.includes('encodeFunctionData'),
      false,
      'rentalOps.ts must not contain encodeFunctionData',
    );
  });

  it('proves apps/web/src/rentalOps.ts does not call buildApproveCall, buildRentCall, buildCancelCall, buildSettleCall', () => {
    assert.equal(sourceContent.includes('buildApproveCall'), false);
    assert.equal(sourceContent.includes('buildRentCall'), false);
    assert.equal(sourceContent.includes('buildCancelCall'), false);
    assert.equal(sourceContent.includes('buildSettleCall'), false);
  });

  it('proves apps/web/src/rentalOps.ts calls all four canonical RentalManagerClient encoders', () => {
    assert.ok(sourceContent.includes('client.encodeApproveCalldata('));
    assert.ok(sourceContent.includes('client.encodeRentCalldata('));
    assert.ok(sourceContent.includes('client.encodeCancelExpiredReservationCalldata('));
    assert.ok(sourceContent.includes('client.encodeSettleAfterExpiryCalldata('));
  });
});
