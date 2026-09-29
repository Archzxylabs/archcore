/**
 * Non-production ABI fixture for agent tests.
 *
 * This file exists only so tests can load an artifact ABI without depending
 * on the real `cargo stylus export-abi` output from Implementator A.
 * Its method set is intentionally smaller than the PRD spec; tests that need
 * specific methods should import this file and assert against its contents.
 *
 * Production code must never import from this directory.
 */

export const TEST_RENTAL_MANAGER_ABI = [
  {
    type: 'function',
    name: 'getRental',
    stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'rentalId' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'uint256', name: 'rentalId' },
          { type: 'uint256', name: 'nodeId' },
          { type: 'address', name: 'renter' },
          { type: 'address', name: 'provider' },
          { type: 'uint256', name: 'price' },
          { type: 'uint8', name: 'status' },
          { type: 'uint256', name: 'startDeadline' },
          { type: 'uint256', name: 'startsAt' },
          { type: 'uint256', name: 'expiresAt' },
          { type: 'uint256', name: 'createdAt' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'activeRentalForNode',
    stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'nodeId' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'uint256', name: 'rentalId' },
          { type: 'uint256', name: 'nodeId' },
          { type: 'address', name: 'renter' },
          { type: 'address', name: 'provider' },
          { type: 'uint256', name: 'price' },
          { type: 'uint8', name: 'status' },
          { type: 'uint256', name: 'startDeadline' },
          { type: 'uint256', name: 'startsAt' },
          { type: 'uint256', name: 'expiresAt' },
          { type: 'uint256', name: 'createdAt' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'startRental',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'rentalId' }],
    outputs: [],
  },
];
