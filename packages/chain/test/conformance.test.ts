// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Conformance test suite asserting exact agreement between:
 *  - Authoritative interface ledger (docs/coordination/INTERFACE_CONTRACTS.md)
 *  - Generated production ABI artifacts (packages/abi/RentalManager.json & ComputeAsset.json)
 *  - Chain decoders and normalized types in @archcore/chain
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  areAddressesEqual,
  formatTokenAmount,
} from '../src/rentalManagerClient';
import {
  decodeActiveRentalForNode,
  decodeListing,
  decodeNode,
  decodePlan,
  decodeRental,
  REAL_LISTING_FIELDS_ORDER,
  REAL_NODE_FIELDS_ORDER,
  REAL_PLAN_FIELDS_ORDER,
  REAL_RENTAL_FIELDS_ORDER,
} from '../src/decode';
import { StatusMapper } from '../src/status';
import {
  CHAIN_ID,
  FROZEN_PLANS,
  USDG_ADDRESS,
  USDG_DECIMALS_EXPECTED,
} from '@archcore/shared';

const ABI_DIR = path.resolve(__dirname, '../../abi');

interface AbiItem {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: { name: string; type: string; internalType?: string }[];
  outputs?: { name: string; type: string; internalType?: string }[];
}

function loadArtifact(name: string): AbiItem[] {
  const filePath = path.join(ABI_DIR, `${name}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as AbiItem[];
}

const rmAbi = loadArtifact('RentalManager');
const caAbi = loadArtifact('ComputeAsset');

describe('RentalManager ABI Conformance', () => {
  const rmFunctions = rmAbi.filter((x) => x.type === 'function');
  const rmFunctionMap = new Map(rmFunctions.map((fn) => [fn.name!, fn]));

  const REQUIRED_RM_FUNCTIONS = [
    'paymentToken',
    'planCount',
    'getPlan',
    'getNode',
    'getListing',
    'getRental',
    'activeRentalForNode',
    'rent',
    'startRental',
    'cancelExpiredReservation',
    'settleAfterExpiry',
  ];

  test('1. RentalManager exports EXACTLY the 11 ledger production functions', () => {
    assert.equal(
      rmFunctions.length,
      11,
      `RentalManager must have exactly 11 functions, got ${rmFunctions.length}: [${[...rmFunctionMap.keys()].join(', ')}]`,
    );
    for (const name of REQUIRED_RM_FUNCTIONS) {
      assert.ok(rmFunctionMap.has(name), `Missing required function: ${name}`);
    }
  });

  test('2. Deprecated and forbidden selectors are ABSENT from RentalManager ABI', () => {
    const FORBIDDEN = [
      'nodeIsRented',
      'getActiveRentalForNode',
      'rentalPrice',
      'rentalStatus',
      'reservationSeconds',
      'rentalDurationSeconds',
      'rentalCount',
      'escrowed',
      'computeAsset',
      'owner',
      'transferOwnership',
      'renounceOwnership',
    ];
    for (const forbidden of FORBIDDEN) {
      assert.equal(
        rmFunctionMap.has(forbidden),
        false,
        `Forbidden function "${forbidden}" MUST NOT be in RentalManager ABI`,
      );
    }
  });

  test('3. Exact mutability, parameter types, and output types for all 11 methods', () => {
    // paymentToken() view returns (address)
    const pt = rmFunctionMap.get('paymentToken')!;
    assert.equal(pt.stateMutability, 'view');
    assert.deepEqual(pt.inputs?.map((i) => i.type), []);
    assert.deepEqual(pt.outputs?.map((o) => o.type), ['address']);

    // planCount() view returns (uint8)
    const pc = rmFunctionMap.get('planCount')!;
    assert.equal(pc.stateMutability, 'view');
    assert.deepEqual(pc.inputs?.map((i) => i.type), []);
    assert.deepEqual(pc.outputs?.map((o) => o.type), ['uint8']);

    // getPlan(uint8) view returns (uint8, uint256, uint256, bool, bool)
    const gp = rmFunctionMap.get('getPlan')!;
    assert.equal(gp.stateMutability, 'view');
    assert.deepEqual(gp.inputs?.map((i) => i.type), ['uint8']);
    assert.deepEqual(gp.outputs?.map((o) => o.type), ['uint8', 'uint256', 'uint256', 'bool', 'bool']);

    // getNode(uint256) view returns (uint256, address, bytes32, bool)
    const gn = rmFunctionMap.get('getNode')!;
    assert.equal(gn.stateMutability, 'view');
    assert.deepEqual(gn.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(gn.outputs?.map((o) => o.type), ['uint256', 'address', 'bytes32', 'bool']);

    // getListing(uint256) view returns (uint256, address, bool) — NO PRICE
    const gl = rmFunctionMap.get('getListing')!;
    assert.equal(gl.stateMutability, 'view');
    assert.deepEqual(gl.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(gl.outputs?.map((o) => o.type), ['uint256', 'address', 'bool']);

    // getRental(uint256) view returns 12-tuple
    const gr = rmFunctionMap.get('getRental')!;
    assert.equal(gr.stateMutability, 'view');
    assert.deepEqual(gr.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(gr.outputs?.map((o) => o.type), [
      'uint256', 'uint256', 'uint8', 'address', 'address',
      'uint256', 'uint256', 'uint8', 'uint256', 'uint256', 'uint256', 'uint256',
    ]);

    // activeRentalForNode(uint256) view returns (bool, uint256)
    const ar = rmFunctionMap.get('activeRentalForNode')!;
    assert.equal(ar.stateMutability, 'view');
    assert.deepEqual(ar.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(ar.outputs?.map((o) => o.type), ['bool', 'uint256']);

    // rent(uint256, uint8) nonpayable returns (uint256)
    const rent = rmFunctionMap.get('rent')!;
    assert.equal(rent.stateMutability, 'nonpayable', 'rent must be nonpayable for ERC-20 payment');
    assert.deepEqual(rent.inputs?.map((i) => i.type), ['uint256', 'uint8']);
    assert.deepEqual(rent.outputs?.map((o) => o.type), ['uint256']);

    // startRental(uint256) nonpayable returns ()
    const start = rmFunctionMap.get('startRental')!;
    assert.equal(start.stateMutability, 'nonpayable');
    assert.deepEqual(start.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(start.outputs?.map((o) => o.type) ?? [], []);

    // cancelExpiredReservation(uint256) nonpayable returns ()
    const cancel = rmFunctionMap.get('cancelExpiredReservation')!;
    assert.equal(cancel.stateMutability, 'nonpayable');
    assert.deepEqual(cancel.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(cancel.outputs?.map((o) => o.type) ?? [], []);

    // settleAfterExpiry(uint256) nonpayable returns ()
    const settle = rmFunctionMap.get('settleAfterExpiry')!;
    assert.equal(settle.stateMutability, 'nonpayable');
    assert.deepEqual(settle.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(settle.outputs?.map((o) => o.type) ?? [], []);
  });
});

describe('ComputeAsset ABI Conformance', () => {
  const caFunctions = caAbi.filter((x) => x.type === 'function');
  const caFunctionMap = new Map(caFunctions.map((fn) => [fn.name!, fn]));

  test('4. ComputeAsset exports ownerOf and isActive with exact signatures', () => {
    // ownerOf(uint256) view returns (address)
    assert.ok(caFunctionMap.has('ownerOf'), 'ComputeAsset must export ownerOf');
    const ownerOf = caFunctionMap.get('ownerOf')!;
    assert.equal(ownerOf.stateMutability, 'view');
    assert.deepEqual(ownerOf.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(ownerOf.outputs?.map((o) => o.type), ['address']);

    // isActive(uint256) view returns (bool)
    assert.ok(caFunctionMap.has('isActive'), 'ComputeAsset must export isActive');
    const isActive = caFunctionMap.get('isActive')!;
    assert.equal(isActive.stateMutability, 'view');
    assert.deepEqual(isActive.inputs?.map((i) => i.type), ['uint256']);
    assert.deepEqual(isActive.outputs?.map((o) => o.type), ['bool']);

    // nodeExists and nodeRetired
    assert.ok(caFunctionMap.has('nodeExists'), 'ComputeAsset must export nodeExists');
    assert.ok(caFunctionMap.has('nodeRetired'), 'ComputeAsset must export nodeRetired');
  });
});

describe('Decoders and Negative / Fail-Closed Tests', () => {
  const statusMapper = new StatusMapper();

  test('5. decodeRental strictly decodes 12-tuple and preserves bigints', () => {
    const valid12Tuple = [
      1n,                                           // rentalId
      1n,                                           // nodeId
      0,                                            // planId
      '0x1111111111111111111111111111111111111111',  // renter
      '0x2222222222222222222222222222222222222222',  // provider
      100000n,                                      // priceAtomic
      300n,                                         // durationSeconds
      1,                                            // status (RESERVED)
      1700000120n,                                  // startDeadline
      0n,                                           // startsAt
      0n,                                           // expiresAt
      1700000000n,                                  // createdAt
    ];

    const decoded = decodeRental(valid12Tuple, {}, { status: statusMapper });
    assert.equal(decoded.rentalId, 1n);
    assert.equal(decoded.nodeId, 1n);
    assert.equal(decoded.planId, 0);
    assert.equal(decoded.renter, '0x1111111111111111111111111111111111111111');
    assert.equal(decoded.provider, '0x2222222222222222222222222222222222222222');
    assert.equal(decoded.priceAtomic, 100000n);
    assert.equal(decoded.durationSeconds, 300n);
    assert.equal(decoded.status, 'RESERVED');
    assert.equal(decoded.startDeadline, 1700000120n);
    assert.equal(decoded.startsAt, 0n);
    assert.equal(decoded.expiresAt, 0n);
    assert.equal(decoded.createdAt, 1700000000n);
  });

  test('6. decodeRental fails closed on truncated, malformed, or wrong-width data', () => {
    // Truncated (10 elements instead of 12)
    const truncated10 = [1n, 1n, 0, '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 100000n, 300n, 1, 1700000120n, 0n];
    assert.throws(
      () => decodeRental(truncated10, {}, { status: statusMapper }),
      /positional order has 12 fields but the getter returned 10/,
    );

    // Wrong width (13 elements)
    const oversized13 = [...truncated10, 0n, 1700000000n, 999n];
    assert.throws(
      () => decodeRental(oversized13, {}, { status: statusMapper }),
      /positional order has 12 fields but the getter returned 13/,
    );

    // Malformed address
    const badAddress = [
      1n, 1n, 0, 'not-an-address', '0x2222222222222222222222222222222222222222',
      100000n, 300n, 1, 1700000120n, 0n, 0n, 1700000000n,
    ];
    assert.throws(
      () => decodeRental(badAddress, {}, { status: statusMapper }),
      /not a valid 20-byte address/,
    );

    // Unknown status enum value
    const badStatus = [
      1n, 1n, 0, '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222',
      100000n, 300n, 99, 1700000120n, 0n, 0n, 1700000000n,
    ];
    assert.throws(
      () => decodeRental(badStatus, {}, { status: statusMapper }),
      /Rental status index 99 is outside the configured order/,
    );
  });

  test('7. decodeNode and decodeListing fail closed on wrong width or bad types', () => {
    // decodeNode truncated (3 elements instead of 4)
    assert.throws(
      () => decodeNode([1n, '0x2222222222222222222222222222222222222222', '0x00']),
      /positional order has 4 fields but the getter returned 3/,
    );

    // decodeListing truncated (2 elements instead of 3)
    assert.throws(
      () => decodeListing([1n, '0x7e955252e15c84f5768b83c41a71f9eba181802f']),
      /positional order has 3 fields but the getter returned 2/,
    );

    // decodePlan truncated (4 elements instead of 5)
    assert.throws(
      () => decodePlan([0, 300n, 100000n, true]),
      /positional order has 5 fields but the getter returned 4/,
    );
  });

  test('8. decodeActiveRentalForNode strictly decodes (bool, uint256)', () => {
    assert.deepEqual(decodeActiveRentalForNode([false, 0n]), [false, 0n]);
    assert.deepEqual(decodeActiveRentalForNode([true, 42n]), [true, 42n]);

    // Malformed shapes
    assert.throws(() => decodeActiveRentalForNode([true]), /unsupported shape/);
    assert.throws(() => decodeActiveRentalForNode([true, 1n, 2n]), /unsupported shape/);
    assert.throws(() => decodeActiveRentalForNode('invalid'), /unsupported shape/);
  });

  test('9. Address normalization and comparison is case-insensitive', () => {
    const raw = '0x7E955252E15C84F5768B83C41A71F9EBA181802F';
    const lower = '0x7e955252e15c84f5768b83c41a71f9eba181802f';
    assert.equal(areAddressesEqual(raw, lower), true);
    assert.equal(areAddressesEqual(raw, USDG_ADDRESS), true);
  });

  test('10. formatTokenAmount formats with verified token decimals', () => {
    assert.equal(formatTokenAmount(100000n, 6), '0.1');
    assert.equal(formatTokenAmount(6000000n, 6), '6');
    assert.equal(formatTokenAmount(11400000n, 6), '11.4');
    assert.equal(formatTokenAmount(142800000n, 6), '142.8');
    assert.equal(formatTokenAmount(1n, 6), '0.000001');
    assert.equal(formatTokenAmount(0n, 6), '0');
  });

  test('11. Frozen plan catalog matches contract constants exactly', () => {
    assert.equal(FROZEN_PLANS.length, 7);
    assert.equal(CHAIN_ID, 46630);
    assert.equal(USDG_DECIMALS_EXPECTED, 6);

    const plan0 = FROZEN_PLANS[0];
    assert.equal(plan0.planId, 0);
    assert.equal(plan0.durationSeconds, 300n);
    assert.equal(plan0.priceAtomic, 100000n);
    assert.equal(plan0.demoOnly, true);

    const plan1 = FROZEN_PLANS[1];
    assert.equal(plan1.planId, 1);
    assert.equal(plan1.durationSeconds, 21600n);
    assert.equal(plan1.priceAtomic, 6000000n);
    assert.equal(plan1.demoOnly, false);
  });
});
