/** Test RPC/signer doubles only. These tests never contact or write a live chain. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeErrorResult, type PublicClient, type WalletClient, type Hex } from 'viem';
import { RentalManagerClient } from '../src/rentalManagerClient';
import { loadChainConfig } from '../src/env';
import { StatusMapper } from '../src/status';
import { asBigInt, asBoolean, asNumber, decodeNode } from '../src/decode';

const manager = `0x${'22'.repeat(20)}`;
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`); // Disposable public TEST key.
const txHash = `0x${'ab'.repeat(32)}` as Hex;

function rig(isSettle = false) {
  const state = { chainId: 46630, nodeId: 1n, provider: signer.address, status: isSettle ? 2 : 1,
    timestamp: isSettle ? 1500n : 999n, deadline: 1000n, expiresAt: 1200n, simulationFails: false, rpcFails: false,
    receiptStatus: 'success', writes: 0, simulations: 0, waited: false, returnedId: 7n };
  const publicClient = {
    getChainId: async () => { if (state.rpcFails) throw Error('TEST RPC unavailable'); return state.chainId; },
    getBlock: async () => ({ timestamp: state.timestamp }),
    readContract: async () => [state.returnedId, state.nodeId, 0, signer.address, state.provider,
      100_000n, 300n, state.status, state.deadline, 0n, state.expiresAt, 880n],
    simulateContract: async (call: any) => {
      state.simulations++;
      assert.equal(call.functionName, 'startRental');
      assert.deepEqual(call.args, [7n]);
      assert.equal(call.account.address, signer.address);
      if (state.simulationFails) throw Error('TEST simulation reverted');
    },
    call: async (request: any) => {
      state.simulations++;
      assert.equal(request.to, manager);
      assert.equal(request.data.slice(0, 10), '0xb44fc704');
      assert.equal(request.value, 0n);
      assert.equal(request.account.address, signer.address);
      if (state.simulationFails) throw Error('TEST simulation reverted');
      return { data: '0x' };
    },
    waitForTransactionReceipt: async ({ hash }: any) => {
      assert.equal(hash, txHash); state.waited = true; return { status: state.receiptStatus };
    },
  } as unknown as PublicClient;
  const walletClient = { account: signer, chain: { id: 46630 }, writeContract: async (call: any) => {
    assert.equal(call.functionName, 'startRental');
    assert.deepEqual(call.args, [7n]);
    assert.equal(call.address, manager); state.writes++; return txHash;
  }, sendTransaction: async (request: any) => {
    const expected = RentalManagerClient.create({
      chainId: 46630,
      nodeId: 1n,
      rpcUrl: 'https://rpc.example',
      rentalManagerAddress: manager,
      publicClientOverride: publicClient,
    }).encodeSettleAfterExpiryCalldata(7n);
    assert.equal(request.to, expected.to);
    assert.equal(request.data, expected.data);
    assert.equal(request.value, expected.value);
    assert.equal(request.account.address, signer.address);
    state.writes++;
    return txHash;
  } } as unknown as WalletClient;
  const config = { chainId: 46630, nodeId: 1n, rpcUrl: 'https://rpc.example',
    rentalManagerAddress: manager, publicClientOverride: publicClient, walletClientOverride: walletClient };
  return { state, config, client: RentalManagerClient.create(config) };
}

describe('provider transaction preflight', () => {
  it('simulates with frozen provider and waits for mined success', async () => {
    const { client, state } = rig();
    assert.equal(await client.startRental(7n), txHash);
    assert.equal(state.simulations, 1); assert.equal(state.writes, 1); assert.equal(state.waited, true);
  });
  const failures: Array<[string, (state: ReturnType<typeof rig>['state']) => void]> = [
    ['wrong chain', (s) => { s.chainId = 1; }],
    ['wrong node', (s) => { s.nodeId = 2n; }],
    ['wrong frozen provider', (s) => { s.provider = `0x${'33'.repeat(20)}`; }],
    ['no longer RESERVED', (s) => { s.status = 2; }],
    ['exact deadline', (s) => { s.timestamp = s.deadline; }],
    ['RPC unavailable', (s) => { s.rpcFails = true; }],
    ['simulation failure', (s) => { s.simulationFails = true; }],
    ['mismatched rental ID', (s) => { s.returnedId = 8n; }],
  ];
  for (const [name, mutate] of failures) it(`never writes for ${name}`, async () => {
    const { client, state } = rig(); mutate(state);
    await assert.rejects(client.startRental(7n)); assert.equal(state.writes, 0);
  });
  it('requires an available transaction signer', async () => {
    const { config, state } = rig();
    await assert.rejects(RentalManagerClient.create({ ...config, walletClientOverride: undefined }).startRental(7n), /wallet is not configured/);
    assert.equal(state.writes, 0);
  });
  it('does not report a reverted mined start as successful', async () => {
    const { client, state } = rig(); state.receiptStatus = 'reverted';
    await assert.rejects(client.startRental(7n), /reverted/);
  });
});

describe('provider settlement transaction preflight', () => {
  it('simulates settleAfterExpiry and waits for mined success', async () => {
    const { client, state } = rig(true);
    assert.equal(await client.settleAfterExpiry(7n), txHash);
    assert.equal(state.simulations, 1); assert.equal(state.writes, 1); assert.equal(state.waited, true);
  });
  it('submitSettleAfterExpiry returns txHash without waiting for receipt', async () => {
    const { client, state } = rig(true);
    assert.equal(await client.submitSettleAfterExpiry(7n), txHash);
    assert.equal(state.simulations, 1); assert.equal(state.writes, 1); assert.equal(state.waited, false);
  });
  const failures: Array<[string, (state: ReturnType<typeof rig>['state']) => void]> = [
    ['wrong chain', (s) => { s.chainId = 1; }],
    ['wrong node', (s) => { s.nodeId = 2n; }],
    ['no longer ACTIVE', (s) => { s.status = 1; }],
    ['not yet expired', (s) => { s.timestamp = 1000n; s.expiresAt = 1200n; }],
    ['zero expiresAt', (s) => { s.expiresAt = 0n; }],
    ['RPC unavailable', (s) => { s.rpcFails = true; }],
    ['simulation failure', (s) => { s.simulationFails = true; }],
    ['mismatched rental ID', (s) => { s.returnedId = 8n; }],
  ];
  for (const [name, mutate] of failures) it(`never writes settle for ${name}`, async () => {
    const { client, state } = rig(true); mutate(state);
    await assert.rejects(client.settleAfterExpiry(7n)); assert.equal(state.writes, 0);
  });
  it('requires an available transaction signer for settlement', async () => {
    const { config, state } = rig(true);
    await assert.rejects(RentalManagerClient.create({ ...config, walletClientOverride: undefined }).settleAfterExpiry(7n), /signer is not configured/);
    assert.equal(state.writes, 0);
  });
  it('does not report a reverted mined settle as successful', async () => {
    const { client, state } = rig(true); state.receiptStatus = 'reverted';
    await assert.rejects(client.settleAfterExpiry(7n), /reverted/);
  });
  it('submitTransaction rejects nonpayable transactions with value > 0n', async () => {
    const { client, state } = rig(true);
    const encoded = client.encodeSettleAfterExpiryCalldata(7n);
    await assert.rejects(client.submitTransaction({ ...encoded, value: 1n as any }), /nonpayable/);
    assert.equal(state.writes, 0);
  });
  it('submitTransaction rejects wrong transaction target', async () => {
    const { client, state } = rig(true);
    const encoded = client.encodeSettleAfterExpiryCalldata(7n);
    const wrongTarget = `0x${'55'.repeat(20)}` as `0x${string}`;
    await assert.rejects(
      client.submitTransaction({ ...encoded, to: wrongTarget }),
      /does not match configured RentalManager address/,
    );
    assert.equal(state.writes, 0);
  });
  it('submitTransaction rejects wrong selector', async () => {
    const { client, state } = rig(true);
    // 1. Unknown selector
    const badData = ('0xd02931a2' + '00'.repeat(32)) as Hex;
    await assert.rejects(
      client.submitTransaction({ to: manager as `0x${string}`, data: badData, value: 0n }),
      /could not be decoded with RentalManager ABI/,
    );
    // 2. Valid ABI function that is not settleAfterExpiry (e.g. cancelExpiredReservation)
    const cancelData = client.encodeCancelCalldata(7n);
    await assert.rejects(
      client.submitTransaction(cancelData),
      /expected settleAfterExpiry/,
    );
    assert.equal(state.writes, 0);
  });
  it('submitTransaction rejects truncated calldata', async () => {
    const { client, state } = rig(true);
    const truncated = '0xb44fc70400000007' as Hex; // only 8 bytes instead of 36 bytes
    await assert.rejects(
      client.submitTransaction({ to: manager as `0x${string}`, data: truncated, value: 0n }),
      /calldata must be exactly 36 bytes/,
    );
    assert.equal(state.writes, 0);
  });
  it('submitTransaction rejects trailing calldata', async () => {
    const { client, state } = rig(true);
    const trailing = ('0xb44fc704' + '00'.repeat(32) + '01') as Hex; // 37 bytes
    await assert.rejects(
      client.submitTransaction({ to: manager as `0x${string}`, data: trailing, value: 0n }),
      /calldata must be exactly 36 bytes/,
    );
    assert.equal(state.writes, 0);
  });
  it('submitTransaction rejects non-positive rentalId', async () => {
    const { client, state } = rig(true);
    const zeroIdData = ('0xb44fc704' + '00'.repeat(32)) as Hex; // rentalId = 0
    await assert.rejects(
      client.submitTransaction({ to: manager as `0x${string}`, data: zeroIdData, value: 0n }),
      /positive integer/,
    );
    assert.equal(state.writes, 0);
  });
  it('submitTransaction submits exact encoded to and data', async () => {
    const { client, state } = rig(true);
    const encoded = client.encodeSettleAfterExpiryCalldata(7n);
    assert.equal(await client.submitTransaction(encoded), txHash);
    assert.equal(state.simulations, 1);
    assert.equal(state.writes, 1);
  });
  it('submitTransaction fails closed when exact raw transaction forwarding is unavailable', async () => {
    const { config, state } = rig(true);
    const writeContractOnly = {
      account: signer,
      chain: { id: 46630 },
      writeContract: async () => {
        state.writes++;
        return txHash;
      },
    } as unknown as WalletClient;
    const client = RentalManagerClient.create({ ...config, walletClientOverride: writeContractOnly });
    const encoded = client.encodeSettleAfterExpiryCalldata(7n);

    await assert.rejects(
      client.submitTransaction(encoded),
      /sendTransaction is required to submit the exact encoded transaction request/,
    );
    assert.equal(state.writes, 0);
  });
  it('getBlockTimestamp returns current block timestamp as bigint', async () => {
    const { client, state } = rig(true);
    state.timestamp = 1700000000n;
    const ts = await client.getBlockTimestamp();
    assert.equal(typeof ts, 'bigint');
    assert.equal(ts, 1700000000n);
  });
});

describe('absence is not an RPC failure', () => {
  it('returns null only for the exact RentalDoesNotExist error for the requested ID', async () => {
    const { config } = rig();
    const data = encodeErrorResult({ abi: [{ type: 'error', name: 'RentalDoesNotExist', inputs: [{ type: 'uint256' }] }],
      errorName: 'RentalDoesNotExist', args: [7n] });
    const client = RentalManagerClient.create({ ...config, publicClientOverride: {
      readContract: async () => { throw { cause: { data } }; },
    } as unknown as PublicClient });
    assert.equal(await client.getRentalOrNull(7n), null);
    await assert.rejects(client.getRentalOrNull(8n));
  });
  it('propagates transport failure instead of fabricating rental absence', async () => {
    const { config } = rig();
    const client = RentalManagerClient.create({ ...config, publicClientOverride: {
      readContract: async () => { throw Error('TEST RPC unavailable'); },
    } as unknown as PublicClient });
    await assert.rejects(client.getRentalOrNull(7n), /TEST RPC unavailable/);
  });
});

describe('frozen interpretation and exact numeric reads', () => {
  it('rejects environment overrides of network, node, tuple order, or selectors', () => {
    for (const env of [{ RH_CHAIN_ID: '1' }, { ARCHCORE_NODE_ID: '2' }, { RENTAL_FIELDS_ORDER: 'renter,provider' },
      { RENTAL_STATUS_ORDER: 'ACTIVE,RESERVED' }, { RM_METHOD_ACTIVERENTALFORNODE: 'nodeIsRented' }]) {
      assert.throws(() => loadChainConfig(env));
    }
    assert.equal(loadChainConfig({}).chainId, 46630);
  });
  it('rejects enum and tuple reorder rather than silently interpreting another contract', () => {
    assert.throws(() => new StatusMapper(['NONE', 'ACTIVE', 'RESERVED', 'COMPLETED', 'CANCELLED']));
    assert.throws(() => decodeNode([1n, signer.address, '', true], { nodeFieldsOrder: 'nodeId,provider,active,name' }));
  });
  it('does not round floating-point or unsafe integer onchain quantities', () => {
    for (const value of [-1, -1n, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => asBigInt(value, 'priceAtomic')); assert.throws(() => asNumber(value, 'planId'));
    }
    assert.equal(asBigInt('9007199254740993', 'priceAtomic'), 9007199254740993n);
    for (const value of [2, -1, NaN, 'true']) assert.throws(() => asBoolean(value, 'active'));
  });
});
