import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RentalManagerClient,
  type ChainConfig,
  formatTokenAmount,
  areAddressesEqual,
} from '../src/rentalManagerClient';
import { ComputeAssetClient } from '../src/computeAssetClient';
import { encodeFunctionData, type PublicClient, type TransactionReceipt } from 'viem';

const DUMMY_RENTAL_MANAGER = '0x1111111111111111111111111111111111111111';
const DUMMY_PAYMENT_TOKEN = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const DUMMY_RENTER = '0x2222222222222222222222222222222222222222';
const DUMMY_PROVIDER = '0x3333333333333333333333333333333333333333';

function createMockPublicClient(handlers: {
  readContract?: (args: any) => Promise<unknown>;
  waitForTransactionReceipt?: (args: any) => Promise<TransactionReceipt>;
  getCode?: (args: any) => Promise<string | undefined>;
}): PublicClient {
  return {
    readContract: handlers.readContract ?? (async () => { throw new Error('Unhandled readContract'); }),
    waitForTransactionReceipt: handlers.waitForTransactionReceipt ?? (async () => { throw new Error('Unhandled waitForTransactionReceipt'); }),
    getCode: handlers.getCode ?? (async () => '0x'),
  } as unknown as PublicClient;
}

describe('RentalManagerClient Unit & Fail-Closed Tests', () => {
  it('creates client with valid shipped ABI and reports expected methods', () => {
    const client = RentalManagerClient.create({
      chainId: 46630,
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      rentalManagerAddress: DUMMY_RENTAL_MANAGER,
      nodeId: 1n,
    });

    assert.equal(client.config.chainId, 46630);
    assert.equal(client.getMethod('rent'), 'rent');
    assert.equal(client.getMethod('activeRentalForNode'), 'activeRentalForNode');
    assert.equal(client.report.methods.rent, 'rent');
  });

  it('fails creation if required method is missing from ABI', () => {
    assert.throws(
      () => {
        RentalManagerClient.create({
          chainId: 46630,
          rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
          rentalManagerAddress: DUMMY_RENTAL_MANAGER,
          nodeId: 1n,
          methodOverrides: {
            // override to a method name not in the v0.5 ABI
            activeRentalForNode: 'nonExistentOccupancySelector',
          },
        });
      },
      /missing required methods/i,
    );
  });

  describe('getActiveRentalForNode fail-closed semantics', () => {
    it('returns null when node has no active rental [false, 0n]', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'activeRentalForNode') {
            return [false, 0n];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const result = await client.getActiveRentalForNode(1n);
      assert.equal(result, null);
    });

    it('returns rental when [true, 42n] and getRental returns matching node with ACTIVE status', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName, args }) => {
          if (functionName === 'activeRentalForNode') {
            return [true, 42n];
          }
          if (functionName === 'getRental') {
            assert.deepEqual(args, [42n]);
            return [
              42n,                    // rentalId
              1n,                     // nodeId
              0,                      // planId
              DUMMY_RENTER,           // renter
              DUMMY_PROVIDER,         // provider
              100000n,                // priceAtomic
              300n,                   // durationSeconds
              2,                      // status: ACTIVE (2)
              1000n,                  // startDeadline
              1005n,                  // startsAt
              1305n,                  // expiresAt
              900n,                   // createdAt
            ];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const result = await client.getActiveRentalForNode(1n);
      assert.ok(result);
      assert.equal(result.rentalId, 42n);
      assert.equal(result.nodeId, 1n);
      assert.equal(result.status, 'ACTIVE');
      assert.equal(result.renter, DUMMY_RENTER.toLowerCase());
      assert.equal(result.priceAtomic, 100000n);
    });

    it('throws when activeRentalForNode returns contradictory [true, 0n]', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'activeRentalForNode') {
            return [true, 0n];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      await assert.rejects(
        () => client.getActiveRentalForNode(1n),
        /contradictory state/i,
      );
    });

    it('throws when activeRentalForNode returns contradictory [false, 42n]', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'activeRentalForNode') {
            return [false, 42n];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      await assert.rejects(
        () => client.getActiveRentalForNode(1n),
        /contradictory state/i,
      );
    });

    it('throws when referenced rental is not found on chain', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'activeRentalForNode') {
            return [true, 999n];
          }
          if (functionName === 'getRental') {
            throw Object.assign(new Error('execution reverted'), { data: encodeFunctionData({
              abi: [{ type: 'function', name: 'RentalDoesNotExist', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'view' }],
              functionName: 'RentalDoesNotExist', args: [999n],
            }) });
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      await assert.rejects(
        () => client.getActiveRentalForNode(1n),
        /was not found on chain/i,
      );
    });

    it('throws when referenced rental has mismatched nodeId', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'activeRentalForNode') {
            return [true, 5n];
          }
          if (functionName === 'getRental') {
            return [
              5n,                     // rentalId
              2n,                     // nodeId: 2n (mismatched! queried was 1n)
              0,
              DUMMY_RENTER,
              DUMMY_PROVIDER,
              100000n,
              300n,
              2,                      // status: ACTIVE
              1000n,
              1005n,
              1305n,
              900n,
            ];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      await assert.rejects(
        () => client.getActiveRentalForNode(1n),
        /node ID mismatch/i,
      );
    });

    it('throws when activeRental has terminal status (e.g. COMPLETED)', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'activeRentalForNode') {
            return [true, 7n];
          }
          if (functionName === 'getRental') {
            return [
              7n,
              1n,
              0,
              DUMMY_RENTER,
              DUMMY_PROVIDER,
              100000n,
              300n,
              3,                      // status: COMPLETED (3) - impossible for active!
              1000n,
              1005n,
              1305n,
              900n,
            ];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      await assert.rejects(
        () => client.getActiveRentalForNode(1n),
        /terminal or unexpected status/i,
      );
    });
  });

  describe('isNodeRentable 4-condition check', () => {
    function setupEligibilityMock(opts: {
      nodeActive: boolean;
      listingActive: boolean;
      hasActiveRental: boolean;
      planActive: boolean;
    }) {
      return createMockPublicClient({
        readContract: async ({ functionName }) => {
          if (functionName === 'getNode') {
            return [1n, DUMMY_PROVIDER, '0x0000000000000000000000000000000000000000000000000000000000000000', opts.nodeActive];
          }
          if (functionName === 'getListing') {
            return [1n, DUMMY_PAYMENT_TOKEN, opts.listingActive];
          }
          if (functionName === 'activeRentalForNode') {
            return opts.hasActiveRental ? [true, 10n] : [false, 0n];
          }
          if (functionName === 'getRental') {
            return [10n, 1n, 0, DUMMY_RENTER, DUMMY_PROVIDER, 100000n, 300n, 2, 1000n, 1005n, 1305n, 900n];
          }
          if (functionName === 'getPlan') {
            return [0, 300n, 100000n, opts.planActive, true];
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });
    }

    it('returns eligible: true when all 4 conditions are satisfied', async () => {
      const mockClient = setupEligibilityMock({
        nodeActive: true,
        listingActive: true,
        hasActiveRental: false,
        planActive: true,
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const res = await client.isNodeRentable(1n, 0);
      assert.deepEqual(res, { eligible: true });
    });

    it('returns eligible: false when node is inactive', async () => {
      const mockClient = setupEligibilityMock({
        nodeActive: false,
        listingActive: true,
        hasActiveRental: false,
        planActive: true,
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const res = await client.isNodeRentable(1n, 0);
      assert.equal(res.eligible, false);
      assert.match(res.reason!, /Node 1 is inactive/i);
    });

    it('returns eligible: false when listing is inactive', async () => {
      const mockClient = setupEligibilityMock({
        nodeActive: true,
        listingActive: false,
        hasActiveRental: false,
        planActive: true,
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const res = await client.isNodeRentable(1n, 0);
      assert.equal(res.eligible, false);
      assert.match(res.reason!, /Listing for node 1 is inactive/i);
    });

    it('returns eligible: false when node already has an active rental', async () => {
      const mockClient = setupEligibilityMock({
        nodeActive: true,
        listingActive: true,
        hasActiveRental: true,
        planActive: true,
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const res = await client.isNodeRentable(1n, 0);
      assert.equal(res.eligible, false);
      assert.match(res.reason!, /already has an active or reserved rental/i);
    });

    it('returns eligible: false when plan is inactive', async () => {
      const mockClient = setupEligibilityMock({
        nodeActive: true,
        listingActive: true,
        hasActiveRental: false,
        planActive: false,
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const res = await client.isNodeRentable(1n, 0);
      assert.equal(res.eligible, false);
      assert.match(res.reason!, /Plan 0 is inactive/i);
    });
  });

  describe('Call builders and transaction verification', () => {
    it('buildRentCall generates exact nonpayable descriptor with value: 0n', () => {
      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
      });

      const rentCall = client.buildRentCall(1n, 0);
      assert.equal(rentCall.functionName, 'rent');
      assert.deepEqual(rentCall.args, [1n, 0]);
      assert.equal(rentCall.value, 0n);
      assert.equal(rentCall.address, DUMMY_RENTAL_MANAGER.toLowerCase());
    });

    it('buildApproveCall generates valid ERC-20 approval call descriptor with value: 0n', () => {
      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        paymentTokenAddress: DUMMY_PAYMENT_TOKEN,
        nodeId: 1n,
      });

      const approveCall = client.buildApproveCall(DUMMY_RENTAL_MANAGER as `0x${string}`, 100000n);
      assert.equal(approveCall.functionName, 'approve');
      assert.deepEqual(approveCall.args, [DUMMY_RENTAL_MANAGER.toLowerCase(), 100000n]);
      assert.equal(approveCall.value, 0n);
      assert.equal(approveCall.address, DUMMY_PAYMENT_TOKEN.toLowerCase());
    });

    it('waitForTransactionSuccess resolves on status === success', async () => {
      const mockClient = createMockPublicClient({
        waitForTransactionReceipt: async ({ hash }) => ({
          status: 'success',
          transactionHash: hash,
        } as unknown as TransactionReceipt),
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      const receipt = await client.waitForTransactionSuccess('0xabcdef');
      assert.equal(receipt.status, 'success');
    });

    it('waitForTransactionSuccess throws when status !== success', async () => {
      const mockClient = createMockPublicClient({
        waitForTransactionReceipt: async ({ hash }) => ({
          status: 'reverted',
          transactionHash: hash,
        } as unknown as TransactionReceipt),
      });

      const client = RentalManagerClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        rentalManagerAddress: DUMMY_RENTAL_MANAGER,
        nodeId: 1n,
        publicClientOverride: mockClient,
      });

      await assert.rejects(
        () => client.waitForTransactionSuccess('0xabcdef'),
        /reverted or failed onchain/i,
      );
    });
  });

  describe('ComputeAssetClient tests', () => {
    it('creates client with shipped ABI and invokes ownerOf and isActive', async () => {
      const mockClient = createMockPublicClient({
        readContract: async ({ functionName, args }) => {
          if (functionName === 'ownerOf') {
            assert.deepEqual(args, [1n]);
            return DUMMY_PROVIDER;
          }
          if (functionName === 'isActive') {
            assert.deepEqual(args, [1n]);
            return true;
          }
          throw new Error(`Unexpected function ${functionName}`);
        },
      });

      const client = ComputeAssetClient.create({
        chainId: 46630,
        rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
        computeAssetAddress: '0x4444444444444444444444444444444444444444',
        publicClientOverride: mockClient,
      });

      const owner = await client.ownerOf(1n);
      assert.equal(owner, DUMMY_PROVIDER.toLowerCase());

      const active = await client.isActive(1n);
      assert.equal(active, true);
    });
  });
});
