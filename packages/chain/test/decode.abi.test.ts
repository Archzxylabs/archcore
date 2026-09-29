// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The `getRental` and related decoders are checked against the real ABI artifact
 * that actually ships (`packages/abi/RentalManager.json`). If the contract
 * changes shape, these tests fail immediately.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  decodeListing,
  decodeNode,
  decodePlan,
  decodeRental,
  DEFAULT_RENTAL_FIELDS_ORDER,
  REAL_RENTAL_FIELDS_ORDER,
} from '../src/decode';
import { StatusMapper } from '../src/status';

const ABI_PATH = path.resolve(__dirname, '../../abi/RentalManager.json');

interface AbiFunction {
  type: string;
  name?: string;
  inputs?: { name: string; type: string }[];
  outputs?: { name: string; type: string }[];
  stateMutability?: string;
}

function loadAbi(): AbiFunction[] {
  return JSON.parse(readFileSync(ABI_PATH, 'utf8')) as AbiFunction[];
}

const abi = loadAbi();
const getRental = abi.find((entry) => entry.type === 'function' && entry.name === 'getRental');
const getListing = abi.find((entry) => entry.type === 'function' && entry.name === 'getListing');
const getNode = abi.find((entry) => entry.type === 'function' && entry.name === 'getNode');
const getPlan = abi.find((entry) => entry.type === 'function' && entry.name === 'getPlan');

test('the shipped ABI exports getRental as a flat 12-tuple, not a named struct', () => {
  assert.ok(getRental, 'packages/abi/RentalManager.json must export getRental');
  const outputTypes = (getRental.outputs ?? []).map((output) => output.type);
  assert.equal(outputTypes.length, 12);
  assert.equal(outputTypes.length, REAL_RENTAL_FIELDS_ORDER.length);
  assert.deepEqual(outputTypes, [
    'uint256', // rentalId
    'uint256', // nodeId
    'uint8',   // planId
    'address', // renter
    'address', // provider
    'uint256', // priceAtomic
    'uint256', // durationSeconds
    'uint8',   // status
    'uint256', // startDeadline
    'uint256', // startsAt
    'uint256', // expiresAt
    'uint256', // createdAt
  ]);
});

test('the exported order is the frozen ledger v0.5 order', () => {
  assert.equal(DEFAULT_RENTAL_FIELDS_ORDER.length, 12);
  assert.equal(REAL_RENTAL_FIELDS_ORDER.length, 12);
  assert.deepEqual([...REAL_RENTAL_FIELDS_ORDER], [...DEFAULT_RENTAL_FIELDS_ORDER]);
  for (const present of ['rentalId', 'nodeId', 'planId', 'priceAtomic', 'durationSeconds', 'startsAt']) {
    assert.ok(
      REAL_RENTAL_FIELDS_ORDER.includes(present as never),
      `${present} must be read from the tuple`,
    );
  }
});

test('decodeRental reads the 12-tuple in the exported column order', () => {
  const tuple = [
    1000n,                                      // rentalId
    1n,                                         // nodeId
    0,                                          // planId
    '0x1111111111111111111111111111111111111111', // renter
    '0x2222222222222222222222222222222222222222', // provider
    100000n,                                    // priceAtomic
    300n,                                       // durationSeconds
    2,                                          // status = ACTIVE
    1700000120n,                                // startDeadline
    1700000010n,                                // startsAt
    1700000310n,                                // expiresAt
    1700000000n,                                // createdAt
  ];

  const rental = decodeRental(tuple, {}, { status: new StatusMapper() });

  assert.equal(rental.rentalId, 1000n);
  assert.equal(rental.nodeId, 1n);
  assert.equal(rental.planId, 0);
  assert.equal(rental.renter, '0x1111111111111111111111111111111111111111');
  assert.equal(rental.provider, '0x2222222222222222222222222222222222222222');
  assert.equal(rental.priceAtomic, 100000n);
  assert.equal(rental.durationSeconds, 300n);
  assert.equal(rental.status, 'ACTIVE');
  assert.equal(rental.startDeadline, 1700000120n);
  assert.equal(rental.startsAt, 1700000010n);
  assert.equal(rental.expiresAt, 1700000310n);
  assert.equal(rental.createdAt, 1700000000n);
  assert.equal(rental.price, 100000n); // backward compatibility
});

test('decodeListing decodes the 3-value tuple without price', () => {
  assert.ok(getListing, 'getListing must be exported');
  const outputTypes = (getListing.outputs ?? []).map((o) => o.type);
  assert.deepEqual(outputTypes, ['uint256', 'address', 'bool']);

  const tuple = [1n, '0x7e955252e15c84f5768b83c41a71f9eba181802f', true];
  const listing = decodeListing(tuple);

  assert.equal(listing.nodeId, 1n);
  assert.equal(listing.paymentToken, '0x7e955252e15c84f5768b83c41a71f9eba181802f');
  assert.equal(listing.active, true);
});

test('decodeNode decodes the 4-value tuple', () => {
  assert.ok(getNode, 'getNode must be exported');
  const outputTypes = (getNode.outputs ?? []).map((o) => o.type);
  assert.deepEqual(outputTypes, ['uint256', 'address', 'bytes32', 'bool']);

  const tuple = [1n, '0x2222222222222222222222222222222222222222', '0x' + '00'.repeat(32), true];
  const node = decodeNode(tuple);

  assert.equal(node.nodeId, 1n);
  assert.equal(node.provider, '0x2222222222222222222222222222222222222222');
  assert.equal(node.active, true);
});

test('decodePlan decodes the 5-value tuple', () => {
  assert.ok(getPlan, 'getPlan must be exported');
  const outputTypes = (getPlan.outputs ?? []).map((o) => o.type);
  assert.deepEqual(outputTypes, ['uint8', 'uint256', 'uint256', 'bool', 'bool']);

  const tuple = [0, 300n, 100000n, true, true];
  const plan = decodePlan(tuple);

  assert.equal(plan.planId, 0);
  assert.equal(plan.durationSeconds, 300n);
  assert.equal(plan.priceAtomic, 100000n);
  assert.equal(plan.active, true);
  assert.equal(plan.demoOnly, true);
});
