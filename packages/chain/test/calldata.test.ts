import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, toFunctionSelector, type Hex } from 'viem';
import {
  RentalManagerClient,
  ERC20_ABI,
  encodeApproveCalldata,
  encodeRentCalldata,
  encodeCancelExpiredReservationCalldata,
  encodeSettleAfterExpiryCalldata,
  encodeCancelCalldata,
  encodeSettleCalldata,
  type EncodedTransactionRequest,
} from '../src/rentalManagerClient';
import { loadAbi } from '../src/abi';
import { USDG_ADDRESS, FROZEN_PLANS } from '@archcore/shared';

const DUMMY_RENTAL_MANAGER = '0x1111111111111111111111111111111111111111';
const DUMMY_PAYMENT_TOKEN = USDG_ADDRESS;
const DUMMY_SPENDER = '0x2222222222222222222222222222222222222222';

function createTestClient(overrides?: {
  paymentTokenAddress?: string;
  rentalManagerAddress?: string;
  methodOverrides?: Record<string, string>;
}): RentalManagerClient {
  return RentalManagerClient.create({
    chainId: 46630,
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    rentalManagerAddress: overrides?.rentalManagerAddress ?? DUMMY_RENTAL_MANAGER,
    paymentTokenAddress: overrides?.paymentTokenAddress ?? DUMMY_PAYMENT_TOKEN,
    nodeId: 1n,
    methodOverrides: overrides?.methodOverrides as never,
  });
}

describe('Transaction Calldata Encoding API', () => {
  const client = createTestClient();
  const rentalManagerAbi = loadAbi('RentalManager');

  // =========================================================================
  // Section A: Approval Encoding
  // =========================================================================
  describe('A. Approval Encoding', () => {
    it('encodes exact approve(spender, amount) targeting configured payment token with value 0n', () => {
      const amount = 100_000n; // Plan 0 price
      const tx = client.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, amount);

      // 1. to equals configured payment token
      assert.equal(tx.to, DUMMY_PAYMENT_TOKEN.toLowerCase());

      // 2. value is strictly 0n
      assert.equal(tx.value, 0n);

      // 3. 4-byte selector matches approve(address,uint256)
      assert.equal(tx.data.slice(0, 10), '0x095ea7b3');

      // 4. decodes cleanly with ERC20_ABI
      const decoded = decodeFunctionData({
        abi: ERC20_ABI,
        data: tx.data,
      });
      assert.equal(decoded.functionName, 'approve');
      assert.equal(decoded.args[0].toLowerCase(), DUMMY_RENTAL_MANAGER.toLowerCase());
      assert.equal(decoded.args[1], amount);
    });

    it('allows overriding token address explicitly', () => {
      const customToken = '0x3333333333333333333333333333333333333333';
      const tx = client.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, 500_000n, customToken);
      assert.equal(tx.to, customToken.toLowerCase());
      assert.equal(tx.value, 0n);
    });

    it('allows zero atomic amount approval (standard ERC-20 reset)', () => {
      const tx = client.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, 0n);
      const decoded = decodeFunctionData({
        abi: ERC20_ABI,
        data: tx.data,
      });
      assert.equal(decoded.args[1], 0n);
      assert.equal(tx.value, 0n);
    });

    it('rejects negative amountAtomic before encoding', () => {
      assert.throws(
        () => client.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, -1n),
        (err: unknown) => err instanceof RangeError && /cannot be negative/i.test((err as Error).message),
      );
    });

    it('rejects amountAtomic exceeding uint256 max', () => {
      const overflow = (1n << 256n);
      assert.throws(
        () => client.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, overflow),
        (err: unknown) => err instanceof RangeError && /exceeds uint256 max/i.test((err as Error).message),
      );
    });

    it('rejects invalid or malformed spender address', () => {
      assert.throws(
        () => client.encodeApproveCalldata('not-an-address', 100_000n),
        /not a valid 20-byte address/i,
      );
    });

    it('rejects missing paymentTokenAddress when neither configured nor passed', () => {
      const unconfiguredClient = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        // no paymentTokenAddress configured
      });
      assert.throws(
        () => unconfiguredClient.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, 100_000n),
        /not a valid 20-byte address/i,
      );
    });
  });

  // =========================================================================
  // Section B: Rent Encoding
  // =========================================================================
  describe('B. Rent Encoding', () => {
    it('encodes exact rent(nodeId, planId) targeting RentalManager with value 0n', () => {
      const nodeId = 1n;
      const planId = 0;
      const tx = client.encodeRentCalldata(nodeId, planId);

      // 1. to equals configured RentalManager
      assert.equal(tx.to, DUMMY_RENTAL_MANAGER.toLowerCase());

      // 2. value is strictly 0n
      assert.equal(tx.value, 0n);

      // 3. 4-byte selector matches rent(uint256,uint8)
      assert.equal(tx.data.slice(0, 10), '0x0d04909f');

      // 4. decodes cleanly with generated RentalManager ABI
      const decoded = decodeFunctionData({
        abi: rentalManagerAbi,
        data: tx.data,
      });
      assert.equal(decoded.functionName, 'rent');
      assert.equal(decoded.args[0], nodeId);
      assert.equal(decoded.args[1], planId);
    });

    it('encodes all 7 frozen catalog plans deterministically', () => {
      for (const plan of FROZEN_PLANS) {
        const tx1 = client.encodeRentCalldata(1n, plan.planId);
        const tx2 = client.encodeRentCalldata(1n, plan.planId);
        assert.equal(tx1.data, tx2.data, `Deterministic calldata check failed for plan ${plan.planId}`);
        assert.equal(tx1.value, 0n);

        const decoded = decodeFunctionData({
          abi: rentalManagerAbi,
          data: tx1.data,
        });
        assert.equal(decoded.functionName, 'rent');
        assert.equal(decoded.args[0], 1n);
        assert.equal(decoded.args[1], plan.planId);
      }
    });

    it('rejects non-positive nodeId (0n or negative)', () => {
      assert.throws(
        () => client.encodeRentCalldata(0n, 0),
        (err: unknown) => err instanceof RangeError && /must be a positive integer/i.test((err as Error).message),
      );
      assert.throws(
        () => client.encodeRentCalldata(-1n, 0),
        (err: unknown) => err instanceof RangeError && /must be a positive integer/i.test((err as Error).message),
      );
    });

    it('rejects invalid planId (negative or > 255)', () => {
      assert.throws(
        () => client.encodeRentCalldata(1n, -1),
        (err: unknown) => err instanceof RangeError && /between 0 and 255/i.test((err as Error).message),
      );
      assert.throws(
        () => client.encodeRentCalldata(1n, 256),
        (err: unknown) => err instanceof RangeError && /between 0 and 255/i.test((err as Error).message),
      );
    });

    it('rejects non-integer planId', () => {
      assert.throws(
        () => client.encodeRentCalldata(1n, 1.5 as never),
        /not an integer/i,
      );
    });
  });

  // =========================================================================
  // Section C: Expired-Reservation Cancellation Encoding
  // =========================================================================
  describe('C. Expired-Reservation Cancellation Encoding', () => {
    it('encodes cancelExpiredReservation(rentalId) targeting RentalManager with value 0n', () => {
      const rentalId = 42n;
      const tx = client.encodeCancelExpiredReservationCalldata(rentalId);

      // 1. to equals configured RentalManager
      assert.equal(tx.to, DUMMY_RENTAL_MANAGER.toLowerCase());

      // 2. value is strictly 0n
      assert.equal(tx.value, 0n);

      // 3. 4-byte selector matches cancelExpiredReservation(uint256)
      assert.equal(tx.data.slice(0, 10), '0xddb5fb47');

      // 4. decodes cleanly with generated RentalManager ABI
      const decoded = decodeFunctionData({
        abi: rentalManagerAbi,
        data: tx.data,
      });
      assert.equal(decoded.functionName, 'cancelExpiredReservation');
      assert.equal(decoded.args[0], rentalId);
    });

    it('alias encodeCancelCalldata produces identical transaction request', () => {
      const rentalId = 100n;
      const tx1 = client.encodeCancelExpiredReservationCalldata(rentalId);
      const tx2 = client.encodeCancelCalldata(rentalId);
      assert.deepEqual(tx1, tx2);
    });

    it('rejects non-positive rentalId (0n or negative)', () => {
      assert.throws(
        () => client.encodeCancelExpiredReservationCalldata(0n),
        (err: unknown) => err instanceof RangeError && /must be a positive integer/i.test((err as Error).message),
      );
      assert.throws(
        () => client.encodeCancelExpiredReservationCalldata(-5n),
        (err: unknown) => err instanceof RangeError && /must be a positive integer/i.test((err as Error).message),
      );
    });
  });

  // =========================================================================
  // Section D: Expired-Active-Rental Settlement Encoding
  // =========================================================================
  describe('D. Expired-Active-Rental Settlement Encoding', () => {
    it('encodes settleAfterExpiry(rentalId) targeting RentalManager with value 0n', () => {
      const rentalId = 88n;
      const tx = client.encodeSettleAfterExpiryCalldata(rentalId);

      // 1. to equals configured RentalManager
      assert.equal(tx.to, DUMMY_RENTAL_MANAGER.toLowerCase());

      // 2. value is strictly 0n
      assert.equal(tx.value, 0n);

      // 3. 4-byte selector matches settleAfterExpiry(uint256)
      assert.equal(tx.data.slice(0, 10), '0xb44fc704');

      // 4. decodes cleanly with generated RentalManager ABI
      const decoded = decodeFunctionData({
        abi: rentalManagerAbi,
        data: tx.data,
      });
      assert.equal(decoded.functionName, 'settleAfterExpiry');
      assert.equal(decoded.args[0], rentalId);
    });

    it('alias encodeSettleCalldata produces identical transaction request', () => {
      const rentalId = 101n;
      const tx1 = client.encodeSettleAfterExpiryCalldata(rentalId);
      const tx2 = client.encodeSettleCalldata(rentalId);
      assert.deepEqual(tx1, tx2);
    });

    it('rejects non-positive rentalId (0n or negative)', () => {
      assert.throws(
        () => client.encodeSettleAfterExpiryCalldata(0n),
        (err: unknown) => err instanceof RangeError && /must be a positive integer/i.test((err as Error).message),
      );
      assert.throws(
        () => client.encodeSettleAfterExpiryCalldata(-10n),
        (err: unknown) => err instanceof RangeError && /must be a positive integer/i.test((err as Error).message),
      );
    });
  });

  // =========================================================================
  // Section E: ABI/Source/Client Conformance
  // =========================================================================
  describe('E. ABI / Source / Client Conformance', () => {
    it('all four selectors match exact canonical function signatures', () => {
      assert.equal(
        toFunctionSelector('function approve(address,uint256)'),
        '0x095ea7b3',
      );
      assert.equal(
        toFunctionSelector('function rent(uint256,uint8)'),
        '0x0d04909f',
      );
      assert.equal(
        toFunctionSelector('function cancelExpiredReservation(uint256)'),
        '0xddb5fb47',
      );
      assert.equal(
        toFunctionSelector('function settleAfterExpiry(uint256)'),
        '0xb44fc704',
      );
    });

    it('proves generated artifact contains exact function signatures and mutability', () => {
      const rentEntry = rentalManagerAbi.find((item: any) => item.name === 'rent') as any;
      assert.ok(rentEntry, 'rent must exist in RentalManager ABI');
      assert.equal(rentEntry.stateMutability, 'nonpayable');
      assert.deepEqual(
        rentEntry.inputs.map((i: any) => i.type),
        ['uint256', 'uint8'],
      );

      const cancelEntry = rentalManagerAbi.find((item: any) => item.name === 'cancelExpiredReservation') as any;
      assert.ok(cancelEntry, 'cancelExpiredReservation must exist in RentalManager ABI');
      assert.equal(cancelEntry.stateMutability, 'nonpayable');
      assert.deepEqual(
        cancelEntry.inputs.map((i: any) => i.type),
        ['uint256'],
      );

      const settleEntry = rentalManagerAbi.find((item: any) => item.name === 'settleAfterExpiry') as any;
      assert.ok(settleEntry, 'settleAfterExpiry must exist in RentalManager ABI');
      assert.equal(settleEntry.stateMutability, 'nonpayable');
      assert.deepEqual(
        settleEntry.inputs.map((i: any) => i.type),
        ['uint256'],
      );
    });

    it('proves nodeIsRented and getActiveRentalForNode are strictly ABSENT from generated ABI', () => {
      const functionNames = rentalManagerAbi
        .filter((item: any) => item.type === 'function')
        .map((item: any) => item.name);

      assert.equal(
        functionNames.includes('nodeIsRented'),
        false,
        'nodeIsRented must NOT be present in RentalManager ABI',
      );
      assert.equal(
        functionNames.includes('getActiveRentalForNode'),
        false,
        'getActiveRentalForNode must NOT be present in RentalManager ABI',
      );
      assert.equal(
        functionNames.includes('activeRentalForNode'),
        true,
        'activeRentalForNode must be the sole occupancy selector',
      );
    });

    it('all four calls strictly return value === 0n (nonpayable)', () => {
      const approveTx = client.encodeApproveCalldata(DUMMY_RENTAL_MANAGER, 100_000n);
      const rentTx = client.encodeRentCalldata(1n, 0);
      const cancelTx = client.encodeCancelExpiredReservationCalldata(1n);
      const settleTx = client.encodeSettleAfterExpiryCalldata(1n);

      assert.equal(approveTx.value, 0n);
      assert.equal(rentTx.value, 0n);
      assert.equal(cancelTx.value, 0n);
      assert.equal(settleTx.value, 0n);
    });
  });

  // =========================================================================
  // Section F: Public Package Exports & Standalone Functions
  // =========================================================================
  describe('F. Public Package Exports & Standalone Functions', () => {
    it('standalone helpers delegate cleanly to RentalManagerClient instance methods', () => {
      const txApprove = encodeApproveCalldata(client, DUMMY_RENTAL_MANAGER, 100_000n);
      assert.equal(txApprove.to, DUMMY_PAYMENT_TOKEN.toLowerCase());
      assert.equal(txApprove.value, 0n);

      const txRent = encodeRentCalldata(client, 1n, 0);
      assert.equal(txRent.to, DUMMY_RENTAL_MANAGER.toLowerCase());
      assert.equal(txRent.value, 0n);

      const txCancel = encodeCancelExpiredReservationCalldata(client, 42n);
      assert.equal(txCancel.to, DUMMY_RENTAL_MANAGER.toLowerCase());
      assert.equal(txCancel.value, 0n);

      const txSettle = encodeSettleAfterExpiryCalldata(client, 42n);
      assert.equal(txSettle.to, DUMMY_RENTAL_MANAGER.toLowerCase());
      assert.equal(txSettle.value, 0n);

      const txCancelAlias = encodeCancelCalldata(client, 42n);
      assert.deepEqual(txCancelAlias, txCancel);

      const txSettleAlias = encodeSettleCalldata(client, 42n);
      assert.deepEqual(txSettleAlias, txSettle);
    });
  });
});
