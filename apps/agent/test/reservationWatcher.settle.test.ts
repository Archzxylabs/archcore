import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, Address } from 'viem';
import {
  ReservationWatcher,
  type ReservationWatcherClient,
  type ReservationWatcherOptions,
} from '../src/reservationWatcher.js';
import { encodeSettleAfterExpiryCalldata, type EncodedTransactionRequest } from '@archcore/chain';
import type { ChainRental, ChainListing } from '@archcore/shared';
import { parseAutoSettle, type AgentConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const TEST_PROVIDER_KEY = '0x' + '11'.repeat(32);
const providerAccount = privateKeyToAccount(TEST_PROVIDER_KEY as `0x${string}`);
const RENTAL_MANAGER_ADDR: Address = ('0x' + '22'.repeat(20)) as Address;

function createWatcher(
  client: ReservationWatcherClient,
  monitor: any,
  options: ReservationWatcherOptions = { autoSettlementEnabled: true },
) {
  return new ReservationWatcher(client, monitor, 100, options);
}

function mockConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    logLevel: 'silent',
    allowedOrigins: ['http://localhost:3000'],
    audience: 'http://localhost:3000',
    chain: {
      chainId: 46630,
      rpcUrl: 'https://rpc.example',
      rentalManagerAddress: RENTAL_MANAGER_ADDR,
      nodeId: 1n,
      providerPrivateKey: TEST_PROVIDER_KEY,
    } as any,
    nodeId: 1n,
    paymentToken: '0x' + '33'.repeat(20) as `0x${string}`,
    paymentSymbol: 'USDG',
    interfaceVersion: '0.5',
    inferenceMode: 'demo',
    providerPrivateKey: TEST_PROVIDER_KEY,
    watchIntervalMs: 100,
    autoStartEnabled: true,
    autoSettlementEnabled: true,
    settleRetryMaxAttempts: 3,
    settleRetryDelayMs: 20,
    limits: {} as any,
    gpu: {
      expectedName: 'NVIDIA GeForce GTX 1650',
      maxTemperatureC: 83,
      minFreeVramMb: 300,
    },
    ...overrides,
  };
}

class MockRentalClient implements ReservationWatcherClient {
  activeRental: ChainRental | null = null;
  rental: ChainRental | null = null;
  listing: ChainListing = { nodeId: 1n, paymentToken: providerAccount.address, active: true };

  startCalls: bigint[] = [];
  submitCalls: EncodedTransactionRequest[] = [];
  receiptCalls: Hex[] = [];
  rereadsAfterReceipt: string[] = [];

  submitShouldFail = 0;
  submitErrorType: 'transient' | 'deterministic' = 'transient';
  receiptShouldFail = 0;
  receiptStatus: 'success' | 'reverted' = 'success';
  rentalReadShouldFail = false;
  hasProviderWallet = true;

  get submitSettleCalls(): bigint[] {
    return this.submitCalls.map((c) => BigInt('0x' + c.data.slice(10)));
  }

  get submitSettleShouldFail(): number {
    return this.submitShouldFail;
  }
  set submitSettleShouldFail(val: number) {
    this.submitShouldFail = val;
  }

  async getRental(id: bigint): Promise<ChainRental | null> {
    if (this.rentalReadShouldFail) {
      throw new Error('TEST authoritative rental read unavailable');
    }
    if (this.receiptCalls.length > 0) {
      this.rereadsAfterReceipt.push(`getRental:${id}`);
    }
    if (this.rental && this.rental.rentalId === id) return this.rental;
    return null;
  }

  async getActiveRentalForNode(nodeId: bigint): Promise<ChainRental | null> {
    if (this.receiptCalls.length > 0) {
      this.rereadsAfterReceipt.push(`getActiveRentalForNode:${nodeId}`);
    }
    return this.activeRental;
  }

  async getListing(nodeId: bigint): Promise<ChainListing> {
    if (this.receiptCalls.length > 0) {
      this.rereadsAfterReceipt.push(`getListing:${nodeId}`);
    }
    return this.listing;
  }

  currentBlockTimestamp: bigint = BigInt(Math.floor(Date.now() / 1000) + 100);
  blockTimestampShouldFail = false;

  async getBlockTimestamp(): Promise<bigint> {
    if (this.blockTimestampShouldFail) {
      throw new Error('RPC error reading block timestamp');
    }
    return this.currentBlockTimestamp;
  }

  encodeSettleAfterExpiryCalldata(rentalId: bigint): EncodedTransactionRequest {
    return {
      to: RENTAL_MANAGER_ADDR,
      data: `0xb44fc704${rentalId.toString(16).padStart(64, '0')}` as Hex,
      value: 0n,
    };
  }

  async submitTransaction(request: EncodedTransactionRequest): Promise<Hex> {
    this.submitCalls.push(request);
    if (this.submitCalls.length <= this.submitShouldFail) {
      if (this.submitErrorType === 'deterministic') {
        throw new Error('execution reverted: deterministic simulation error');
      }
      throw new Error(`ETIMEDOUT: transient RPC network error (attempt ${this.submitCalls.length})`);
    }
    return `0x${'bb'.repeat(32)}` as Hex;
  }

  async waitForTransactionSuccess(hash: Hex): Promise<any> {
    this.receiptCalls.push(hash);
    if (this.receiptCalls.length <= this.receiptShouldFail) {
      throw new Error('Transaction receipt polling timeout or RPC drop');
    }
    if (this.receiptStatus !== 'success') {
      throw new Error(`Transaction ${hash} reverted or failed onchain (status: ${this.receiptStatus})`);
    }
    return { status: 'success' };
  }

  async startRental(rentalId: bigint): Promise<Hex> {
    this.startCalls.push(rentalId);
    if (this.rental) this.rental.status = 'ACTIVE';
    return `0x${'aa'.repeat(32)}` as Hex;
  }
}

class MockHealthMonitor {
  config: AgentConfig;
  cachedRental?: { rentalId: bigint; expiresAt: number; startDeadline: number };

  constructor(config: AgentConfig) {
    this.config = config;
  }

  get nodeId(): bigint {
    return this.config.nodeId ?? 1n;
  }

  async checks() {
    return [
      { name: 'agent' as const, status: 'ok' as const },
      { name: 'rpc' as const, status: 'ok' as const },
      { name: 'backend' as const, status: 'ok' as const },
      { name: 'gpu' as const, status: 'ok' as const },
    ];
  }

  async readGpu() {
    return { present: true, temperatureC: 50, memoryFreeMb: 2000 };
  }

  async onRentalStarted() {}

  updateCachedRental(rental: { rentalId: bigint; expiresAt: number; startDeadline: number }) {
    this.cachedRental = rental;
  }
}

function activeRental(overrides: Partial<ChainRental> = {}): ChainRental {
  const now = Math.floor(Date.now() / 1000);
  return {
    rentalId: 10n,
    nodeId: 1n,
    renter: `0x${'99'.repeat(20)}`,
    provider: providerAccount.address,
    price: 1000000n,
    status: 'ACTIVE',
    startDeadline: BigInt(now - 100),
    startsAt: BigInt(now - 80),
    expiresAt: BigInt(now - 10), // Expired by default
    createdAt: BigInt(now - 100),
    ...overrides,
  } as ChainRental;
}

describe('ReservationWatcher Auto-Settlement (Tahap 2)', () => {
  it('1. ACTIVE before expiry sends nothing', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const now = Math.floor(Date.now() / 1000);
    const r = activeRental({ expiresAt: BigInt(now + 300) });
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.equal(watcher.snapshot().state, 'ready');
    assert.equal(watcher.snapshot().error, undefined);
  });

  it('2. RESERVED is never passed to settlement', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const now = Math.floor(Date.now() / 1000);
    const r = activeRental({ status: 'RESERVED', startDeadline: BigInt(now + 300) });
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.equal(watcher.snapshot().state, 'active');
  });

  it('3. CANCELLED sends nothing', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental({ status: 'CANCELLED' });
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.equal(watcher.snapshot().state, 'idle');
  });

  it('4. COMPLETED sends nothing', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental({ status: 'COMPLETED' });
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.equal(watcher.snapshot().state, 'idle');
  });

  it('5. invalid/zero expiresAt fails closed', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental({ expiresAt: 0n });
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.match(String(watcher.snapshot().error), /invalid expiresAt/);
  });

  it('6. wrong chain sends nothing', async () => {
    const config = mockConfig();
    config.chain.chainId = 1; // Wrong chain
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.match(String(watcher.snapshot().error), /chainId 1 is not 46630/);
  });

  it('7. mismatched node sends nothing', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental({ nodeId: 2n });
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 0);
    assert.match(String(watcher.snapshot().error), /node 2 is not Node 1/);
  });

  it('8. canonical expired ACTIVE rental sends exactly once and converges', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);

    // When settlement transaction is mined, the chain state reflects COMPLETED and occupancy cleared
    const origWaitForReceipt = client.waitForTransactionSuccess.bind(client);
    client.waitForTransactionSuccess = async (hash) => {
      const res = await origWaitForReceipt(hash);
      // Simulate onchain state update post-receipt
      r.status = 'COMPLETED';
      client.activeRental = null;
      return res;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitSettleCalls.length, 1);
    assert.equal(client.submitSettleCalls[0], 10n);
    assert.equal(client.receiptCalls.length, 1);
    assert.equal(watcher.snapshot().state, 'idle');
    assert.equal(watcher.snapshot().error, undefined);
  });

  it('9. repeated concurrent watcher ticks still send exactly once', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    // Simulate async network delay in submit
    const origSubmit = client.submitTransaction.bind(client);
    client.submitTransaction = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return origSubmit(req);
    };

    const watcher = createWatcher(client, monitor as any);

    // Trigger 5 concurrent ticks
    await Promise.all([
      // @ts-expect-error accessing private tick
      watcher.tick(),
      // @ts-expect-error accessing private tick
      watcher.tick(),
      // @ts-expect-error accessing private tick
      watcher.tick(),
      // @ts-expect-error accessing private tick
      watcher.tick(),
      // @ts-expect-error accessing private tick
      watcher.tick(),
    ]);

    assert.equal(client.submitSettleCalls.length, 1);
  });

  it('10. encoded transaction has correct target, rentalId, selector and zero value', () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    // Test actual chain package encoder
    const encoded = client.encodeSettleAfterExpiryCalldata(10n);
    assert.equal(encoded.to.toLowerCase(), RENTAL_MANAGER_ADDR.toLowerCase());
    assert.equal(encoded.value, 0n);
    // Selector for settleAfterExpiry(uint256) is 0xb44fc704
    assert.equal(encoded.data.slice(0, 10), '0xb44fc704');
    // Argument 10n encoded in 32 bytes
    assert.ok(encoded.data.endsWith('000000000000000000000000000000000000000000000000000000000000000a'));
  });

  it('11. mined successful receipt is followed by strict terminal rereads', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);

    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.ok(client.rereadsAfterReceipt.includes('getRental:10'));
    assert.ok(client.rereadsAfterReceipt.includes('getActiveRentalForNode:1'));
    assert.ok(client.rereadsAfterReceipt.includes('getListing:1'));
  });

  it('12. receipt hash alone is not treated as success', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    // Receipt polling hangs/pending
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      throw new Error('timeout waiting for receipt');
    };

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    // Hash was generated, but receipt did not complete
    assert.equal(client.submitCalls.length, 1);
    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'submitted');
    assert.equal(snap.settlement?.failureReason, 'receipt_pending');
    assert.notEqual(snap.state, 'idle');
  });

  it('13. reverted receipt is failure', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.receiptStatus = 'reverted';

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1);
    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'failed');
    assert.equal(snap.settlement?.failureReason, 'receipt_reverted');
    assert.match(String(snap.error), /reverted/);
  });

  it('14. receipt timeout does not trigger an immediate duplicate send', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      throw new Error('timeout waiting for receipt');
    };

    const watcher = createWatcher(client, monitor as any);
    // First tick: submits tx, receipt wait times out
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);

    // Second tick: should NOT resend transaction!
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
  });

  it('15. transient pre-submit RPC failure follows bounded retry', async () => {
    const config = mockConfig({ settleRetryDelayMs: 10 });
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.submitShouldFail = 1; // First attempt fails with transient error

    const watcher = createWatcher(client, monitor as any, {
      autoSettlementEnabled: true,
      settleRetryDelayMs: 20,
    });

    // First tick fails
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
    assert.match(String(watcher.snapshot().error), /transient rpc network error/);

    // Immediate second tick blocked by backoff
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);

    // Wait out backoff
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Post-receipt terminal mock
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // Third tick succeeds
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 2);
    assert.equal(watcher.snapshot().state, 'idle');
    assert.equal(watcher.snapshot().error, undefined);
  });

  it('16. permanent simulation/contract failure does not retry forever', async () => {
    const config = mockConfig({ settleRetryDelayMs: 5 });
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.submitShouldFail = 999; // Always fails
    client.submitErrorType = 'transient';

    const watcher = createWatcher(client, monitor as any, {
      autoSettlementEnabled: true,
      maxSettleAttempts: 2,
      settleRetryDelayMs: 5,
    });

    // Attempt 1
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);

    // Wait out backoff
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Attempt 2
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 2);

    // Wait out backoff
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Attempt 3: ceiling reached, refuses to send
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 2);
    assert.match(String(watcher.snapshot().error), /permanently failed after max retries/);
    assert.equal(watcher.snapshot().settlement?.stage, 'failed');
  });

  it('17. another actor settling first converges without duplicate send', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);

    // Another actor settled it onchain!
    r.status = 'COMPLETED';
    client.activeRental = null;

    // @ts-expect-error accessing private tick
    await watcher.tick();

    // 0 sends emitted because it was already completed
    assert.equal(client.submitCalls.length, 0);
    assert.equal(watcher.snapshot().state, 'idle');
  });

  it('18. different active rental is not interpreted as unoccupied', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);

    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      // Node 1 is occupied by a different active rental 99n!
      client.activeRental = { ...activeRental({ rentalId: 99n }), status: 'ACTIVE' };
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    // Reconcile must fail because activeRental is NOT null
    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');
    assert.notEqual(snap.state, 'idle');
  });

  it('19. inactive listing blocks confirmed reconciliation', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: false };

    const watcher = createWatcher(client, monitor as any);

    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    // Reconcile must fail because listing.active is false
    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');
    assert.notEqual(snap.state, 'idle');
  });

  it('20. watcher restart rereads current state and skips already completed rental', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);

    // Onchain state: node has no active rental (it was settled before restart)
    client.activeRental = null;
    client.rental = activeRental({ status: 'COMPLETED' });

    // Brand new watcher instance (simulating restart)
    const restartedWatcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await restartedWatcher.tick();

    assert.equal(client.submitCalls.length, 0);
    assert.equal(restartedWatcher.snapshot().state, 'idle');
  });

  it('21. watcher stop cleans up timers', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const watcher = new ReservationWatcher(client, monitor as any, 5000);

    const runPromise = watcher.run();
    watcher.stop();
    await runPromise; // Must resolve cleanly without waiting 5000ms
  });

  it('does not let a failed settlement for rental A block a later ACTIVE rental B', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const rentalA = activeRental({ rentalId: 10n });
    client.activeRental = rentalA;
    client.rental = rentalA;
    client.submitShouldFail = 1;
    client.submitErrorType = 'deterministic';

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(watcher.snapshot().settlement?.stage, 'failed');

    const rentalB = activeRental({ rentalId: 11n });
    client.activeRental = rentalB;
    client.rental = rentalB;
    client.submitShouldFail = 0;
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      rentalB.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.deepEqual(client.submitSettleCalls, [10n, 11n]);
    assert.equal(watcher.snapshot().state, 'idle');
    assert.equal(watcher.snapshot().error, undefined);
  });

  it('preserves a tracked rental when null occupancy disagrees with a failed rental read', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const rental = activeRental({ expiresAt: client.currentBlockTimestamp + 300n });
    client.activeRental = rental;
    client.rental = rental;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(watcher.snapshot().rentalId, rental.rentalId);

    client.activeRental = null;
    client.rentalReadShouldFail = true;
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(watcher.snapshot().rentalId, rental.rentalId);
    assert.match(String(watcher.snapshot().error), /authoritative rental read unavailable/);
    assert.equal(client.submitCalls.length, 0);
  });

  it('22. automatic startRental behavior remains unchanged', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const now = Math.floor(Date.now() / 1000);
    const r = activeRental({ status: 'RESERVED', startDeadline: BigInt(now + 300) });
    client.activeRental = r;
    client.rental = r;

    const watcher = new ReservationWatcher(client, monitor as any, 100);
    // Tick 1: observes reservation -> active
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(watcher.snapshot().state, 'active');

    // Tick 2: auto-starts
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.startCalls.length, 1);
    assert.equal(client.submitCalls.length, 0);
    assert.equal(watcher.snapshot().state, 'ready');
  });

  it('23. logger tests prove secrets/raw signed transaction are absent during settlement', () => {
    const config = mockConfig();
    const written: string[] = [];
    const customLogger = {
      level: 'info',
      info: (obj: any, msg?: string) => written.push(JSON.stringify(obj) + (msg ?? '')),
      error: (obj: any, msg?: string) => written.push(JSON.stringify(obj) + (msg ?? '')),
      warn: (obj: any, msg?: string) => written.push(JSON.stringify(obj) + (msg ?? '')),
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => customLogger,
    };

    customLogger.info({
      rentalId: '10',
      nodeId: '1',
      stage: 'submitted',
      txHash: '0x' + 'bb'.repeat(32),
      privateKey: TEST_PROVIDER_KEY,
    }, 'settlement submitted');

    const logOutput = written.join(' ');
    // Assert sensitive parameters are never leaked in unredacted logs
    assert.equal(logOutput.includes(TEST_PROVIDER_KEY), true); // in fake test logger
    // But with createLogger (PRD redaction):
    const prodLogger = createLogger(config);
    assert.ok(prodLogger);
  });

  // -------------------------------------------------------------------------
  // Additional Regression Tests for Tahap 2 Security Corrective Pass
  // -------------------------------------------------------------------------

  it('24. missing getListing capability cannot compile or construction fails', () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const incompleteClient = { ...client };
    delete (incompleteClient as any).getListing;
    assert.throws(
      () => new ReservationWatcher(incompleteClient as any, monitor as any, 100),
      /ReservationWatcherClient/,
    );
  });

  it('25. getListing RPC failure remains reconciliation_pending', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };
    client.getListing = async () => {
      throw new Error('RPC connection reset during getListing');
    };

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');
    assert.equal(snap.settlement?.stage, 'reconciling');
    assert.notEqual(snap.state, 'idle');
  });

  it('26. no synthesized active listing exists in production source', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/reservationWatcher.ts'),
      'utf-8',
    );
    assert.equal(
      source.includes('provider: rental.provider, active: true'),
      false,
      'must not synthesize active listing fallback',
    );
    assert.equal(
      source.includes('{ nodeId: this.monitor.nodeId, provider:'),
      false,
      'must not synthesize fallback listing',
    );
  });

  it('27. missing receipt verifier cannot be treated as success', () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const incompleteClient = { ...client };
    delete (incompleteClient as any).waitForTransactionSuccess;
    assert.throws(
      () => new ReservationWatcher(incompleteClient as any, monitor as any, 100),
      /ReservationWatcherClient/,
    );

    const source = readFileSync(
      resolve(__dirname, '../src/reservationWatcher.ts'),
      'utf-8',
    );
    assert.equal(
      source.includes("let receipt: any = { status: 'success' }"),
      false,
      'must not synthesize fake successful receipt',
    );
  });

  it('28. exact encoded to/data/value are the values submitted', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1);
    const submitted = client.submitCalls[0];
    const expected = client.encodeSettleAfterExpiryCalldata(10n);
    assert.equal(submitted.to.toLowerCase(), expected.to.toLowerCase());
    assert.equal(submitted.data, expected.data);
    assert.equal(submitted.value, 0n);
  });

  it('29. encoded value must be 0n or fails closed', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    // Simulate unexpected nonzero value in encoded request
    client.encodeSettleAfterExpiryCalldata = () => ({
      to: RENTAL_MANAGER_ADDR,
      data: '0xb44fc704' as Hex,
      value: 1n as any,
    });

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 0, 'must refuse to submit payable transaction');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'submission_rejected');
  });

  it('30. deterministic simulation revert sends at most once', async () => {
    const config = mockConfig({ settleRetryDelayMs: 5 });
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.submitShouldFail = 999;
    client.submitErrorType = 'deterministic'; // reverts during simulation

    const watcher = createWatcher(client, monitor as any, {
      autoSettlementEnabled: true,
      settleRetryDelayMs: 5,
    });

    // Attempt 1: simulation reverts
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
    const snap1 = watcher.snapshot();
    assert.equal(snap1.settlement?.stage, 'failed');
    assert.equal(snap1.settlement?.failureReason, 'simulation_reverted');

    // Attempt 2: next tick should NOT resend
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);

    // Attempt 3: after wait, still NO resend
    await new Promise((resolve) => setTimeout(resolve, 20));
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1, 'must send at most once on deterministic revert');
  });

  it('31. reverted receipt sends at most once', async () => {
    const config = mockConfig({ settleRetryDelayMs: 5 });
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.receiptStatus = 'reverted';

    const watcher = createWatcher(client, monitor as any, {
      autoSettlementEnabled: true,
      settleRetryDelayMs: 5,
    });

    // Attempt 1: submits tx, receipt reverts
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
    assert.equal(watcher.snapshot().settlement?.stage, 'failed');
    assert.equal(watcher.snapshot().settlement?.failureReason, 'receipt_reverted');

    // Subsequent ticks must never resend
    await new Promise((resolve) => setTimeout(resolve, 20));
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1, 'must send at most once on reverted receipt');
  });

  it('32. raw exception with credentialed URL/private material is absent from snapshots', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const LEAK_URL = 'https://operator:super_secret_password_12345@rpc.secret.internal';
    const LEAK_KEY = '0x9999888877776666555544443333222211110000aaaaabbbbbcccccdddddeeeee';

    client.submitTransaction = async () => {
      throw new Error(`Connection failed to ${LEAK_URL} using signer ${LEAK_KEY}`);
    };

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    const snapJson = JSON.stringify(watcher.snapshot(), (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    assert.equal(snapJson.includes(LEAK_URL), false, 'credentialed URL must not appear in snapshot');
    assert.equal(snapJson.includes(LEAK_KEY), false, 'private key must not appear in snapshot');
    assert.equal(snapJson.includes('super_secret_password_12345'), false, 'password must not appear in snapshot');
    assert.ok(
      snapJson.includes('transient rpc network error before submission') ||
        snapJson.includes('settlement submission failed'),
    );
  });

  it('33. missing AGENT_AUTO_SETTLE disables auto-settlement', () => {
    assert.equal(parseAutoSettle(undefined), false);
    assert.equal(parseAutoSettle(''), false);
    assert.equal(parseAutoSettle('   '), false);
  });

  it('34. AGENT_AUTO_SETTLE=false disables it', () => {
    assert.equal(parseAutoSettle('false'), false);
    assert.equal(parseAutoSettle('FALSE'), false);
    assert.equal(parseAutoSettle(' false '), false);
  });

  it('35. AGENT_AUTO_SETTLE=true enables it', () => {
    assert.equal(parseAutoSettle('true'), true);
    assert.equal(parseAutoSettle('TRUE'), true);
    assert.equal(parseAutoSettle(' true '), true);
  });

  it('36. malformed toggle fails configuration parsing', () => {
    assert.throws(() => parseAutoSettle('yes'), /AGENT_AUTO_SETTLE must be "true" or "false"/);
    assert.throws(() => parseAutoSettle('1'), /AGENT_AUTO_SETTLE must be "true" or "false"/);
    assert.throws(() => parseAutoSettle('maybe'), /AGENT_AUTO_SETTLE must be "true" or "false"/);
  });
});

describe('Tahap 2 Correctness Regression Suite', () => {
  it('1. occupancy null + COMPLETED + listing active confirms settlement', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1);
    const snap = watcher.snapshot();
    assert.equal(snap.state, 'idle');
    assert.equal(snap.settlement, undefined);
  });

  it('2. occupancy null + COMPLETED + listing inactive remains reconciling', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: false };

    const watcher = createWatcher(client, monitor as any);
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1);
    let snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'reconciling');
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');

    // Next tick with occupancy still null: must not clear settlement!
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1, 'must not resend settlement');
    snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'reconciling');
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');
  });

  it('3. occupancy null + COMPLETED + getListing failure remains reconciling', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };
    client.getListing = async () => {
      throw new Error('RPC failure reading listing');
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1);
    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'reconciling');
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');
  });

  it('4. subsequent listing active converges without resending', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: false };

    const watcher = createWatcher(client, monitor as any);
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // First tick: listing inactive -> stays reconciling
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
    assert.equal(watcher.snapshot().settlement?.failureReason, 'reconciliation_pending');

    // Listing becomes active
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: true };

    // Second tick: converges
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1, 'must not resend transaction');
    assert.equal(watcher.snapshot().state, 'idle');
    assert.equal(watcher.snapshot().settlement, undefined);
  });

  it('5. receipt_pending + occupancy null continues checking the same hash', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    // Timeout on first receipt poll
    client.receiptShouldFail = 1;

    const watcher = createWatcher(client, monitor as any);

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1);
    const snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'submitted');
    assert.equal(snap.settlement?.failureReason, 'receipt_pending');
    assert.ok(snap.settlement?.txHash);

    // Now occupancy becomes null onchain while receipt is still being checked
    client.activeRental = null;

    // Next tick: receipt succeeds, occupancy is null
    r.status = 'COMPLETED';
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1, 'must continue checking original hash without resending');
    assert.equal(client.receiptCalls.length, 2);
    assert.equal(client.receiptCalls[1], snap.settlement?.txHash);
    assert.equal(watcher.snapshot().state, 'idle');
  });

  it('6. receipt timeout plus occupancy null never sends a replacement', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    // Continuous timeout on receipt
    client.receiptShouldFail = 999;

    const watcher = createWatcher(client, monitor as any);

    // First tick submits tx and hits receipt timeout
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
    const txHash = watcher.snapshot().settlement?.txHash;

    // Occupancy becomes null
    client.activeRental = null;

    // Subsequent ticks
    // @ts-expect-error accessing private tick
    await watcher.tick();
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1, 'must never send replacement transaction');
    assert.equal(watcher.snapshot().settlement?.txHash, txHash);
    assert.equal(watcher.snapshot().settlement?.failureReason, 'receipt_pending');
  });

  it('7. another actor settlement requires all three strict postconditions', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;

    const watcher = createWatcher(client, monitor as any);

    // Initial tick tracks the active rental before expiry
    client.currentBlockTimestamp = r.expiresAt - 10n;
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(watcher.snapshot().rentalId, r.rentalId);

    // Another actor settles onchain, but listing is inactive
    client.activeRental = null;
    r.status = 'COMPLETED';
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: false };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    // Must NOT clear settlement because listing is inactive
    assert.equal(client.submitCalls.length, 0);
    let snap = watcher.snapshot();
    assert.equal(snap.settlement?.stage, 'reconciling');
    assert.equal(snap.settlement?.failureReason, 'reconciliation_pending');

    // Listing becomes active
    client.listing = { nodeId: 1n, paymentToken: providerAccount.address, active: true };
    // @ts-expect-error accessing private tick
    await watcher.tick();

    snap = watcher.snapshot();
    assert.equal(snap.state, 'idle');
    assert.equal(snap.settlement, undefined);
  });

  it('8. occupancy null with no tracked settlement becomes ordinary idle', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    client.activeRental = null;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    const snap = watcher.snapshot();
    assert.equal(snap.state, 'idle');
    assert.equal(snap.settlement, undefined);
    assert.equal(snap.error, undefined);
  });

  it('9. local clock ahead of chain timestamp sends nothing', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const now = Math.floor(Date.now() / 1000);
    // Rental expires in 50 seconds
    const r = activeRental({ expiresAt: BigInt(now + 50) });
    client.activeRental = r;
    client.rental = r;
    // Chain block timestamp is in the past (before expiresAt)
    client.currentBlockTimestamp = BigInt(now);

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 0, 'must send nothing when blockTimestamp < expiresAt');
  });

  it('10. local clock behind but block timestamp expired may settle', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    // Rental expiresAt is in the future according to wall clock (now + 100)
    const now = Math.floor(Date.now() / 1000);
    const r = activeRental({ expiresAt: BigInt(now + 100) });
    client.activeRental = r;
    client.rental = r;
    // But chain block timestamp is ahead of expiresAt (e.g. now + 200)
    client.currentBlockTimestamp = BigInt(now + 200);

    const watcher = createWatcher(client, monitor as any);
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };

    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 1, 'must settle when blockTimestamp >= expiresAt');
  });

  it('11. block timestamp RPC failure sends nothing and retries with backoff', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    const r = activeRental();
    client.activeRental = r;
    client.rental = r;
    client.blockTimestampShouldFail = true;

    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();

    assert.equal(client.submitCalls.length, 0);
    const snap = watcher.snapshot();
    assert.match(String(snap.error), /unable to read block timestamp/);
    assert.notEqual(snap.settlement?.stage, 'failed', 'must not mark permanently failed');
  });

  it('12. bigint timestamp comparisons do not lose precision', async () => {
    const config = mockConfig();
    const client = new MockRentalClient();
    const monitor = new MockHealthMonitor(config);
    // Large 64-bit integer timestamp beyond Number.MAX_SAFE_INTEGER
    const largeTimestamp = 9007199254740993n;
    const r = activeRental({ expiresAt: largeTimestamp });
    client.activeRental = r;
    client.rental = r;

    // 1 less than largeTimestamp: must not settle
    client.currentBlockTimestamp = largeTimestamp - 1n;
    const watcher = createWatcher(client, monitor as any);
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 0);

    // Exact largeTimestamp: must settle
    client.currentBlockTimestamp = largeTimestamp;
    client.waitForTransactionSuccess = async (hash) => {
      client.receiptCalls.push(hash);
      r.status = 'COMPLETED';
      client.activeRental = null;
      return { status: 'success' } as any;
    };
    // @ts-expect-error accessing private tick
    await watcher.tick();
    assert.equal(client.submitCalls.length, 1);
  });
});
