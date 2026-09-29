import { setTimeout } from 'node:timers/promises';
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, TransactionReceipt } from 'viem';
import type { EncodedTransactionRequest } from '@archcore/chain';
import type { Address, ChainListing, ChainRental } from '@archcore/shared';
import { HealthMonitor, gpuAllowsStart } from './health.js';
import type { SettlementJournal, SettlementJob, SettlementJobIdentity, SettlementJobStage } from './journal/index.js';

export type ReservationState = 'idle' | 'active' | 'ready' | 'settling';

export type SettlementStage =
  | 'idle'
  | 'preflight'
  | 'submitted'
  | 'mined'
  | 'reconciling'
  | 'confirmed'
  | 'failed';

export type SettlementFailureReason =
  | 'never_submitted'
  | 'submission_rejected'
  | 'simulation_reverted'
  | 'receipt_pending'
  | 'receipt_reverted'
  | 'reconciliation_pending'
  | 'authoritative_read_failed'
  | 'settled_by_other'
  | 'JOURNAL_TRANSITION_CONFLICT'
  | 'JOURNAL_PERSISTENCE_FAILED'
  | 'CAPABILITY_MISSING'
  | 'AUTO_SETTLEMENT_DISABLED';

export interface SettlementSnapshot {
  rentalId: string;
  stage: SettlementStage;
  txHash?: string;
  attempts: number;
  error?: string;
  failureReason?: SettlementFailureReason;
}

export interface ReservationSnapshot {
  state: ReservationState;
  rentalId?: bigint;
  /** Unix seconds; 0 when there is no active lease. */
  startDeadline: number;
  /** Unix seconds; 0 when there is no active lease. */
  expiresAt: number;
  /** Error from the last failed transition; cleared on success. */
  error?: string;
  /** Settlement snapshot if settling or confirmed. */
  settlement?: SettlementSnapshot;
}

export interface ReservationWatcherOptions {
  autoStartEnabled?: boolean;
  autoSettlementEnabled?: boolean;
  maxSettleAttempts?: number;
  settleRetryDelayMs?: number;
  settleBackoffMaxMs?: number;
  journal?: SettlementJournal;
  claimLeaseMs?: number;
  ownerId?: string;
}

export interface ReservationWatcherClient {
  readonly hasProviderWallet?: boolean;
  readonly providerAddress?: Address;
  getProviderAddress?(): Address;
  getActiveRentalForNode(nodeId: bigint): Promise<ChainRental | null>;
  getRental(rentalId: bigint): Promise<ChainRental | null>;
  getListing(nodeId: bigint): Promise<ChainListing>;
  getBlockTimestamp(): Promise<bigint>;
  encodeSettleAfterExpiryCalldata(rentalId: bigint): EncodedTransactionRequest;
  submitTransaction(request: EncodedTransactionRequest, options?: { nonce?: number }): Promise<Hex>;
  waitForTransactionSuccess(hash: Hex): Promise<TransactionReceipt>;
  startRental(rentalId: bigint): Promise<Hex>;
  getTransactionCount?(address: Address, blockTag?: 'pending' | 'latest'): Promise<number>;
}

export interface DurableReservationWatcherClient extends ReservationWatcherClient {
  readonly providerAddress: Address;
  getTransactionCount(address: Address, blockTag?: 'pending' | 'latest'): Promise<number>;
  submitTransaction(request: EncodedTransactionRequest, options?: { nonce?: number }): Promise<Hex>;
}


function classifySubmissionError(err: unknown): {
  isDeterministic: boolean;
  safeMessage: string;
  reason: SettlementFailureReason;
} {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();

  if (
    lower.includes('revert') ||
    lower.includes('execution reverted') ||
    lower.includes('contractfunctionexecutionerror') ||
    lower.includes('callexecutionerror') ||
    lower.includes('insufficient funds') ||
    lower.includes('out of gas')
  ) {
    return {
      isDeterministic: true,
      safeMessage: 'simulation or contract execution reverted',
      reason: 'simulation_reverted',
    };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('network') ||
    lower.includes('rate limit')
  ) {
    return {
      isDeterministic: false,
      safeMessage: 'transient rpc network error before submission',
      reason: 'submission_rejected',
    };
  }

  return {
    isDeterministic: false,
    safeMessage: 'settlement submission failed',
    reason: 'submission_rejected',
  };
}

function classifyReceiptError(err: unknown): {
  isReverted: boolean;
  safeMessage: string;
} {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();
  if (lower.includes('revert') || lower.includes('failed onchain') || lower.includes('status: 0')) {
    return {
      isReverted: true,
      safeMessage: 'settlement transaction reverted onchain',
    };
  }
  return {
    isReverted: false,
    safeMessage: 'waiting for settlement receipt confirmation',
  };
}

export class ReservationWatcher {
  private rentalId: bigint | null = null;
  private state: ReservationState = 'idle';
  private error: string | undefined;
  /** Consecutive failed `startRental()` attempts for the current reservation. */
  private startFailures = 0;
  /** Wall-clock ms after which another `startRental()` attempt is allowed. */
  private startRetryAtMs = 0;

  /** Consecutive failed settlement attempts for the current expired rental. */
  private settleFailures = 0;
  /** Wall-clock ms after which another settlement attempt is allowed. */
  private settleRetryAtMs = 0;
  /** Concurrency mutex: true while a settlement transaction is actively being submitted. */
  private settleSending = false;

  /** In-memory settlement state machine per rental. */
  private settlement: {
    rentalId: bigint;
    stage: SettlementStage;
    txHash?: Hex;
    attempts: number;
    lastAttemptAtMs: number;
    retryAtMs: number;
    error?: string;
    failureReason?: SettlementFailureReason;
  } | null = null;

  /** Clean shutdown controller. */
  private stopped = false;
  private abortController = new AbortController();

  /** Cap on the exponential backoff, in ms. */
  private static readonly MAX_BACKOFF_MS = 15_000;

  private readonly journal?: SettlementJournal;
  private readonly claimLeaseMs: number;
  private readonly ownerId: string;
  private recoveryRun = false;
  private claimRenewalTimer: NodeJS.Timeout | null = null;

  /**
   * The watcher drives the onchain `startRental()` transition for RESERVED rentals
   * and the automatic `settleAfterExpiry()` transition for expired ACTIVE rentals.
   */
  constructor(
    private readonly client: ReservationWatcherClient,
    private readonly monitor: HealthMonitor,
    private readonly watchIntervalMs: number,
    private readonly options: ReservationWatcherOptions = {},
  ) {
    if (
      !client ||
      typeof client.getActiveRentalForNode !== 'function' ||
      typeof client.getRental !== 'function' ||
      typeof client.getListing !== 'function' ||
      typeof client.getBlockTimestamp !== 'function' ||
      typeof client.encodeSettleAfterExpiryCalldata !== 'function' ||
      typeof client.submitTransaction !== 'function' ||
      typeof client.waitForTransactionSuccess !== 'function' ||
      typeof client.startRental !== 'function'
    ) {
      throw new TypeError('ReservationWatcher requires a complete ReservationWatcherClient implementation');
    }
    this.journal = options.journal;
    this.claimLeaseMs = options.claimLeaseMs ?? 30_000;
    this.ownerId = options.ownerId ?? crypto.randomUUID();
  }

  private getResolvedProviderAddress(): Address | undefined {
    if (this.client.providerAddress) {
      return this.client.providerAddress;
    }
    if (typeof this.client.getProviderAddress === 'function') {
      return this.client.getProviderAddress();
    }
    return undefined;
  }

  private get autoSettlementEnabled(): boolean {
    return this.options.autoSettlementEnabled ?? false;
  }

  private async safeSubmitTransaction(
    request: EncodedTransactionRequest,
    options?: { nonce?: number },
  ): Promise<Hex> {
    if (!this.autoSettlementEnabled) {
      if (this.settlement) {
        this.settlement.stage = 'idle';
        this.settlement.failureReason = 'AUTO_SETTLEMENT_DISABLED';
      }
      throw new Error('AUTO_SETTLEMENT_DISABLED: Transaction broadcast forbidden when auto-settlement is disabled');
    }
    return this.client.submitTransaction(request, options);
  }

  private get autoStartEnabled(): boolean {
    return this.options.autoStartEnabled ?? (this.monitor as any)?.config?.autoStartEnabled ?? true;
  }

  private async transitionJournal(req: {
    targetStage: SettlementJobStage | 'RETRYABLE_FAILURE';
    identity: SettlementJobIdentity;
    mutate: () => Promise<boolean> | boolean;
    fromStage?: string;
    expectedTxHash?: string;
    expectedSender?: string;
    expectedNonce?: string;
    failureCode?: string;
  }): Promise<{
    ok: boolean;
    rereadJob?: SettlementJob | null;
    conflictReason?: SettlementFailureReason;
    error?: string;
  }> {
    if (!this.journal) {
      return { ok: true };
    }

    const mutated = await req.mutate();
    if (mutated) {
      return { ok: true };
    }

    // Mutation returned false: reread row and evaluate monotonic progression / idempotency
    const reread = await this.journal.getJob(req.identity);
    if (!reread) {
      return {
        ok: false,
        conflictReason: 'JOURNAL_PERSISTENCE_FAILED',
        error: 'settlement job not found in journal after failed transition',
      };
    }

    switch (req.targetStage) {
      case 'PREPARING': {
        if (
          reread.stage === 'PREPARING' &&
          reread.claimOwner === this.ownerId &&
          (!req.expectedSender || reread.senderAddress?.toLowerCase() === req.expectedSender.toLowerCase()) &&
          (!req.expectedNonce || reread.transactionNonce === req.expectedNonce)
        ) {
          return { ok: true, rereadJob: reread };
        }
        if (['SUBMITTED', 'MINED', 'RECONCILING', 'CONFIRMED'].includes(reread.stage)) {
          return { ok: true, rereadJob: reread };
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'failed to record PREPARING in journal',
        };
      }

      case 'SUBMITTED': {
        if (req.expectedTxHash && reread.txHash === req.expectedTxHash) {
          if (['SUBMITTED', 'MINED', 'RECONCILING', 'CONFIRMED'].includes(reread.stage)) {
            return { ok: true, rereadJob: reread };
          }
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_PERSISTENCE_FAILED',
          error: 'recordSubmitted failed and journal does not contain expected txHash',
        };
      }

      case 'MINED': {
        if (reread.stage === 'MINED' || reread.stage === 'RECONCILING') {
          if (reread.claimOwner === this.ownerId) {
            return { ok: true, rereadJob: reread };
          }
        }
        if (reread.stage === 'CONFIRMED') {
          return { ok: true, rereadJob: reread };
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'failed to record MINED in journal',
        };
      }

      case 'RECONCILING': {
        if (reread.stage === 'RECONCILING' && reread.claimOwner === this.ownerId) {
          if (req.fromStage === 'RECONCILING') {
            return {
              ok: false,
              rereadJob: reread,
              conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
              error: 'failed to record RECONCILING in journal',
            };
          }
          return { ok: true, rereadJob: reread };
        }
        if (reread.stage === 'CONFIRMED') {
          return { ok: true, rereadJob: reread };
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'failed to record RECONCILING in journal',
        };
      }

      case 'CONFIRMED': {
        if (reread.stage === 'CONFIRMED') {
          return { ok: true, rereadJob: reread };
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'failed to record CONFIRMED in journal',
        };
      }

      case 'FAILED': {
        if (reread.stage === 'FAILED') {
          return { ok: true, rereadJob: reread };
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'failed to record FAILED in journal',
        };
      }

      case 'RETRYABLE_FAILURE': {
        if (reread.stage === 'CONFIRMED' || reread.stage === 'FAILED') {
          return {
            ok: false,
            rereadJob: reread,
            conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
            error: 'job is already terminal',
          };
        }
        if (reread.claimOwner !== this.ownerId) {
          return {
            ok: false,
            rereadJob: reread,
            conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
            error: 'claim lease lost',
          };
        }
        if (req.failureCode && reread.failureCode === req.failureCode) {
          return { ok: true, rereadJob: reread };
        }
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'failed to record retryable failure in journal',
        };
      }

      default:
        return {
          ok: false,
          rereadJob: reread,
          conflictReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'unrecognized journal transition stage',
        };
    }
  }

  private startClaimRenewal(identity: SettlementJobIdentity): void {
    this.stopClaimRenewal();
    const intervalMs = Math.max(10, Math.min(60000, Math.floor(this.claimLeaseMs / 3)));
    this.claimRenewalTimer = setInterval(() => {
      void this.ensureClaimRenewed(identity);
    }, intervalMs);
    if (this.claimRenewalTimer.unref) {
      this.claimRenewalTimer.unref();
    }
  }

  private stopClaimRenewal(): void {
    if (this.claimRenewalTimer !== null) {
      clearInterval(this.claimRenewalTimer);
      this.claimRenewalTimer = null;
    }
  }

  private async ensureClaimRenewed(identity: SettlementJobIdentity): Promise<boolean> {
    if (!this.journal) return true;
    try {
      const renewed = await this.journal.renewClaim(
        identity,
        this.ownerId,
        Date.now() + this.claimLeaseMs,
      );
      if (!renewed) {
        this.stopClaimRenewal();
        this.settleSending = false;
        if (!this.settlement) {
          this.settlement = {
            rentalId: BigInt(identity.rentalId),
            stage: 'failed',
            attempts: 0,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
            failureReason: 'JOURNAL_TRANSITION_CONFLICT',
            error: 'settlement lease renewal failed',
          };
        } else {
          this.settlement.failureReason = 'JOURNAL_TRANSITION_CONFLICT';
          this.settlement.error = 'settlement lease renewal failed';
        }
        this.error = 'settlement lease renewal failed';
        return false;
      }
      return true;
    } catch {
      this.stopClaimRenewal();
      this.settleSending = false;
      if (!this.settlement) {
        this.settlement = {
          rentalId: BigInt(identity.rentalId),
          stage: 'failed',
          attempts: 0,
          lastAttemptAtMs: Date.now(),
          retryAtMs: 0,
          failureReason: 'JOURNAL_TRANSITION_CONFLICT',
          error: 'settlement lease renewal threw error',
        };
      } else {
        this.settlement.failureReason = 'JOURNAL_TRANSITION_CONFLICT';
        this.settlement.error = 'settlement lease renewal threw error';
      }
      this.error = 'settlement lease renewal threw error';
      return false;
    }
  }

  snapshot(): ReservationSnapshot {
    return {
      state: this.state,
      rentalId: this.rentalId ?? undefined,
      startDeadline: this.startDeadline(),
      expiresAt: this.expiresAt(),
      error: this.error,
      settlement: this.settlement
        ? {
            rentalId: this.settlement.rentalId.toString(),
            stage: this.settlement.stage,
            txHash: this.settlement.txHash,
            attempts: this.settlement.attempts,
            error: this.settlement.error,
            failureReason: this.settlement.failureReason,
          }
        : undefined,
    };
  }

  stop(): void {
    this.stopClaimRenewal();
    this.stopped = true;
    this.abortController.abort();
    if (this.journal && this.settlement) {
      try {
        void this.journal.releaseClaim(
          {
            chainId: this.monitor.config.chain.chainId,
            rentalManagerAddress: this.monitor.config.chain.rentalManagerAddress,
            rentalId: this.settlement.rentalId.toString(),
          },
          this.ownerId,
        );
      } catch {
        // Ignore errors during clean shutdown
      }
    }
  }


  async runRecovery(): Promise<void> {
    if (!this.journal) return;
    const scope = {
      chainId: this.monitor.config.chain.chainId,
      rentalManagerAddress: this.monitor.config.chain.rentalManagerAddress,
      nodeId: this.monitor.nodeId.toString(),
    };
    const recoverable = await this.journal.listRecoverableJobs(scope);
    for (const job of recoverable) {
      if (this.stopped) break;
      await this.recoverJob(job);
    }
  }

  private async recoverJob(job: SettlementJob): Promise<void> {
    if (!this.journal) return;
    const identity: SettlementJobIdentity = {
      chainId: job.chainId,
      rentalManagerAddress: job.rentalManagerAddress,
      rentalId: job.rentalId,
    };
    const rentalIdBigInt = BigInt(job.rentalId);

    // Try to claim the job
    const claimed = await this.journal.claimJob(identity, this.ownerId, Date.now() + this.claimLeaseMs);
    if (!claimed) {
      // Another worker holds an unexpired claim or job is confirmed
      return;
    }

    // Confirm claim ownership from a reread (item 7)
    const reread = await this.journal.getJob(identity);
    if (!reread || reread.claimOwner !== this.ownerId) {
      return;
    }

    // Start renewal scoped to this job
    this.startClaimRenewal(identity);
    try {
      await this.executeRecoverJob(job, identity, rentalIdBigInt);
    } finally {
      this.stopClaimRenewal();
    }
  }

  private async executeRecoverJob(
    job: SettlementJob,
    identity: SettlementJobIdentity,
    rentalIdBigInt: bigint,
  ): Promise<void> {
    if (!this.journal) return;

    // 1. If job is SUBMITTED with txHash:
    // (Receipt polling and reconciliation may continue read-only even when autoSettlementEnabled is false;
    // no replacement transaction may be sent).
    if (job.stage === 'SUBMITTED' && job.txHash) {
      this.settlement = {
        rentalId: rentalIdBigInt,
        stage: 'submitted',
        txHash: job.txHash as Hex,
        attempts: job.attempts,
        lastAttemptAtMs: job.updatedAtMs,
        retryAtMs: 0,
      };
      // Poll receipt for exactly this hash (never resend)
      try {
        if (!(await this.ensureClaimRenewed(identity))) return;
        const receipt = await this.client.waitForTransactionSuccess(job.txHash as Hex);
        if (receipt.status === 'success') {
          const minedRes = await this.transitionJournal({
            targetStage: 'MINED',
            identity,
            mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
            fromStage: 'SUBMITTED',
          });
          if (!minedRes.ok) {
            this.settlement.failureReason = minedRes.conflictReason;
            this.settlement.error = minedRes.error;
            this.error = minedRes.error;
            return;
          }
          const recRes = await this.transitionJournal({
            targetStage: 'RECONCILING',
            identity,
            mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
            fromStage: 'MINED',
          });
          if (!recRes.ok) {
            this.settlement.failureReason = recRes.conflictReason;
            this.settlement.error = recRes.error;
            this.error = recRes.error;
            return;
          }
          this.settlement.stage = 'reconciling';
          await this.reconcileTerminalState(rentalIdBigInt);
        } else {
          const failRes = await this.transitionJournal({
            targetStage: 'FAILED',
            identity,
            mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
            fromStage: 'SUBMITTED',
          });
          if (failRes.ok) {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = 'receipt_reverted';
          } else {
            this.settlement.failureReason = failRes.conflictReason;
            this.settlement.error = failRes.error;
          }
          this.error = this.settlement.error;
        }
      } catch (err: unknown) {
        const classified = classifyReceiptError(err);
        if (classified.isReverted) {
          const failRes = await this.transitionJournal({
            targetStage: 'FAILED',
            identity,
            mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
            fromStage: 'SUBMITTED',
          });
          if (failRes.ok) {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = 'receipt_reverted';
          } else {
            this.settlement.failureReason = failRes.conflictReason;
            this.settlement.error = failRes.error;
          }
          this.error = this.settlement.error;
        } else {
          // Timeout / network error: retain known hash, keep in submitted/receipt_pending
          this.settlement.stage = 'submitted';
          this.settlement.failureReason = 'receipt_pending';
        }
      }
      return;
    }

    // 2. If job is MINED or RECONCILING:
    if (job.stage === 'MINED' || job.stage === 'RECONCILING') {
      this.settlement = {
        rentalId: rentalIdBigInt,
        stage: 'reconciling',
        txHash: (job.txHash as Hex) ?? undefined,
        attempts: job.attempts,
        lastAttemptAtMs: job.updatedAtMs,
        retryAtMs: 0,
      };
      if (!(await this.ensureClaimRenewed(identity))) return;
      const recRes = await this.transitionJournal({
        targetStage: 'RECONCILING',
        identity,
        mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
        fromStage: job.stage,
      });
      if (!recRes.ok) {
        this.settlement.failureReason = recRes.conflictReason;
        this.settlement.error = recRes.error;
        this.error = recRes.error;
        return;
      }
      this.settlement.stage = 'reconciling';
      await this.reconcileTerminalState(rentalIdBigInt);
      return;
    }

    // 3. If job is PREPARING:
    if (job.stage === 'PREPARING') {
      // Read fresh authoritative onchain state
      let rental: ChainRental | null = null;
      let occ: ChainRental | null = null;
      let listing: ChainListing | null = null;
      try {
        [rental, occ, listing] = await Promise.all([
          this.client.getRental(rentalIdBigInt),
          this.client.getActiveRentalForNode(this.monitor.nodeId),
          this.client.getListing(this.monitor.nodeId),
        ]);
      } catch {
        // RPC read failure during recovery: keep job as is, release claim
        await this.journal.releaseClaim(identity, this.ownerId);
        return;
      }

      // If chain already proves completed, unoccupied, and listing active:
      // mark CONFIRMED without sending! (Allowed whether autoSettlementEnabled is true or false,
      // and regardless of whether a nonce was stored — chain is authoritative.)
      const isCompleted = rental !== null && rental.status === 'COMPLETED';
      const isUnoccupied = occ === null;
      const isListingAvailable = listing !== null && listing.nodeId === this.monitor.nodeId && listing.active === true;

      if (isCompleted && isUnoccupied && isListingAvailable) {
        const confRes = await this.transitionJournal({
          targetStage: 'CONFIRMED',
          identity,
          mutate: () => this.journal!.recordConfirmed(identity, { ownerId: this.ownerId }),
          fromStage: 'PREPARING',
        });
        if (confRes.ok) {
          if (this.settlement?.rentalId === rentalIdBigInt) {
            this.clearSettlement();
          }
        } else {
          if (!this.settlement) {
            this.settlement = {
              rentalId: rentalIdBigInt,
              stage: 'idle',
              attempts: job.attempts,
              lastAttemptAtMs: job.updatedAtMs,
              retryAtMs: 0,
            };
          }
          this.settlement.failureReason = confRes.conflictReason;
          this.settlement.error = confRes.error;
          this.error = confRes.error;
        }
        return;
      }

      // KILL SWITCH: When auto-settlement is disabled:
      // Leave it non-broadcasting, expose AUTO_SETTLEMENT_DISABLED, no nonce lookup, no send!
      if (!this.autoSettlementEnabled) {
        this.settlement = {
          rentalId: rentalIdBigInt,
          stage: 'idle',
          attempts: job.attempts,
          lastAttemptAtMs: job.updatedAtMs,
          retryAtMs: 0,
          failureReason: 'AUTO_SETTLEMENT_DISABLED',
        };
        await this.journal.releaseClaim(identity, this.ownerId);
        return;
      }

      // If auto-settlement IS enabled:
      // Branch 4A: Unprepared PREPARING row (txHash, senderAddress, transactionNonce are null)
      if (!job.transactionNonce) {
        if (!(await this.ensureClaimRenewed(identity))) return;

        let blockTimestamp = 0n;
        try {
          blockTimestamp = await this.client.getBlockTimestamp();
        } catch {
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'idle',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: Date.now() + 2000,
            failureReason: 'authoritative_read_failed',
          };
          await this.journal.releaseClaim(identity, this.ownerId);
          return;
        }

        if (
          !rental ||
          rental.status !== 'ACTIVE' ||
          !rental.expiresAt ||
          rental.expiresAt <= 0n ||
          blockTimestamp < rental.expiresAt
        ) {
          // Preflight conditions not met
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'idle',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: Date.now() + 2000,
            failureReason: 'authoritative_read_failed',
          };
          await this.journal.releaseClaim(identity, this.ownerId);
          return;
        }

        const sender = this.getResolvedProviderAddress();
        if (!sender || !this.client.getTransactionCount) {
          const failRes = await this.transitionJournal({
            targetStage: 'FAILED',
            identity,
            mutate: () => this.journal!.recordFailed(identity, { failureCode: 'CAPABILITY_MISSING', ownerId: this.ownerId }),
          });
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: failRes.ok ? 'failed' : 'idle',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
            failureReason: failRes.ok ? 'CAPABILITY_MISSING' : failRes.conflictReason,
            error: failRes.ok ? undefined : failRes.error,
          };
          this.error = this.settlement.error;
          return;
        }

        let pendingNonce: number;
        try {
          pendingNonce = await this.client.getTransactionCount(sender, 'pending');
        } catch {
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'idle',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: Date.now() + 2000,
            failureReason: 'authoritative_read_failed',
          };
          await this.journal.releaseClaim(identity, this.ownerId);
          return;
        }

        if (!(await this.ensureClaimRenewed(identity))) return;
        const prepRes = await this.transitionJournal({
          targetStage: 'PREPARING',
          identity,
          mutate: () => this.journal!.recordPreparing(identity, {
            senderAddress: sender,
            transactionNonce: pendingNonce.toString(),
            ownerId: this.ownerId,
          }),
          expectedSender: sender,
          expectedNonce: pendingNonce.toString(),
        });
        if (!prepRes.ok) {
          await this.journal.releaseClaim(identity, this.ownerId);
          return;
        }

        const verifiedRow = await this.journal.getJob(identity);
        if (
          !verifiedRow ||
          verifiedRow.stage !== 'PREPARING' ||
          verifiedRow.transactionNonce !== pendingNonce.toString() ||
          verifiedRow.senderAddress?.toLowerCase() !== sender.toLowerCase() ||
          verifiedRow.claimOwner !== this.ownerId
        ) {
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'failed',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
            failureReason: 'JOURNAL_TRANSITION_CONFLICT',
          };
          return;
        }

        // Only then permit initial broadcast
        const encoded = this.client.encodeSettleAfterExpiryCalldata(rentalIdBigInt);
        this.settlement = {
          rentalId: rentalIdBigInt,
          stage: 'preflight',
          attempts: job.attempts + 1,
          lastAttemptAtMs: Date.now(),
          retryAtMs: 0,
        };
        this.settleSending = true;
        try {
          if (!(await this.ensureClaimRenewed(identity))) return;
          const txHash = await this.safeSubmitTransaction(encoded, { nonce: pendingNonce });
          const subRes = await this.transitionJournal({
            targetStage: 'SUBMITTED',
            identity,
            mutate: () => this.journal!.recordSubmitted(identity, { txHash, ownerId: this.ownerId }),
            expectedTxHash: txHash,
          });
          this.settlement.txHash = txHash;
          this.settleSending = false;
          if (!subRes.ok) {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = subRes.conflictReason;
            this.settlement.error = subRes.error;
            this.error = subRes.error;
            return;
          }
          this.settlement.stage = 'submitted';
          if (!(await this.ensureClaimRenewed(identity))) return;
          const receipt = await this.client.waitForTransactionSuccess(txHash);
          if (receipt.status === 'success') {
            const minedRes = await this.transitionJournal({
              targetStage: 'MINED',
              identity,
              mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
            });
            if (!minedRes.ok) {
              this.settlement.failureReason = minedRes.conflictReason;
              this.settlement.error = minedRes.error;
              this.error = minedRes.error;
              return;
            }
            const recRes = await this.transitionJournal({
              targetStage: 'RECONCILING',
              identity,
              mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
            });
            if (!recRes.ok) {
              this.settlement.failureReason = recRes.conflictReason;
              this.settlement.error = recRes.error;
              this.error = recRes.error;
              return;
            }
            this.settlement.stage = 'reconciling';
            await this.reconcileTerminalState(rentalIdBigInt);
          } else {
            const failRes = await this.transitionJournal({
              targetStage: 'FAILED',
              identity,
              mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
            });
            if (failRes.ok) {
              this.settlement.stage = 'failed';
              this.settlement.failureReason = 'receipt_reverted';
            } else {
              this.settlement.failureReason = failRes.conflictReason;
              this.settlement.error = failRes.error;
            }
            this.error = this.settlement.error;
          }
        } catch (err: unknown) {
          this.settleSending = false;
          const classified = classifyReceiptError(err);
          if (classified.isReverted) {
            const failRes = await this.transitionJournal({
              targetStage: 'FAILED',
              identity,
              mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
            });
            if (failRes.ok) {
              this.settlement.stage = 'failed';
              this.settlement.failureReason = 'receipt_reverted';
            } else {
              this.settlement.failureReason = failRes.conflictReason;
              this.settlement.error = failRes.error;
            }
            this.error = this.settlement.error;
          } else {
            this.settlement.stage = 'submitted';
            this.settlement.failureReason = 'receipt_pending';
          }
        }
        return;
      }

      // Branch 4B: Stored nonce PREPARING recovery
      const sender = (job.senderAddress ?? this.getResolvedProviderAddress()) as Address | undefined;
      if (!sender || !this.client.getTransactionCount) {
        const failRes = await this.transitionJournal({
          targetStage: 'FAILED',
          identity,
          mutate: () => this.journal!.recordFailed(identity, { failureCode: 'CAPABILITY_MISSING', ownerId: this.ownerId }),
        });
        this.settlement = {
          rentalId: rentalIdBigInt,
          stage: failRes.ok ? 'failed' : 'idle',
          attempts: job.attempts,
          lastAttemptAtMs: Date.now(),
          retryAtMs: 0,
          failureReason: failRes.ok ? 'CAPABILITY_MISSING' : failRes.conflictReason,
          error: failRes.ok ? undefined : failRes.error,
        };
        this.error = this.settlement.error;
        return;
      }

      let latestCount: number;
      let pendingCount: number;
      try {
        [latestCount, pendingCount] = await Promise.all([
          this.client.getTransactionCount(sender, 'latest'),
          this.client.getTransactionCount(sender, 'pending'),
        ]);
      } catch {
        await this.journal.releaseClaim(identity, this.ownerId);
        return;
      }

      const storedNonce = BigInt(job.transactionNonce);

      // Case A: unconsumed nonce (latest <= stored && pending <= stored)
      if (BigInt(latestCount) <= storedNonce && BigInt(pendingCount) <= storedNonce) {
        let blockTimestamp = 0n;
        try {
          blockTimestamp = await this.client.getBlockTimestamp();
        } catch {
          await this.journal.releaseClaim(identity, this.ownerId);
          return;
        }

        if (
          rental &&
          rental.status === 'ACTIVE' &&
          rental.expiresAt > 0n &&
          blockTimestamp >= rental.expiresAt
        ) {
          const encoded = this.client.encodeSettleAfterExpiryCalldata(rentalIdBigInt);
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'preflight',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
          };
          this.settleSending = true;
          try {
            if (!(await this.ensureClaimRenewed(identity))) return;
            const txHash = await this.safeSubmitTransaction(encoded, { nonce: Number(storedNonce) });
            const subRes = await this.transitionJournal({
              targetStage: 'SUBMITTED',
              identity,
              mutate: () => this.journal!.recordSubmitted(identity, { txHash, ownerId: this.ownerId }),
              expectedTxHash: txHash,
            });
            this.settlement.txHash = txHash;
            this.settleSending = false;
            if (!subRes.ok) {
              this.settlement.stage = 'failed';
              this.settlement.failureReason = subRes.conflictReason;
              this.settlement.error = subRes.error;
              this.error = subRes.error;
              return;
            }
            this.settlement.stage = 'submitted';
            if (!(await this.ensureClaimRenewed(identity))) return;
            const receipt = await this.client.waitForTransactionSuccess(txHash);
            if (receipt.status === 'success') {
              const minedRes = await this.transitionJournal({
                targetStage: 'MINED',
                identity,
                mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
              });
              if (!minedRes.ok) {
                this.settlement.failureReason = minedRes.conflictReason;
                this.settlement.error = minedRes.error;
                this.error = minedRes.error;
                return;
              }
              const recRes = await this.transitionJournal({
                targetStage: 'RECONCILING',
                identity,
                mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
              });
              if (!recRes.ok) {
                this.settlement.failureReason = recRes.conflictReason;
                this.settlement.error = recRes.error;
                this.error = recRes.error;
                return;
              }
              this.settlement.stage = 'reconciling';
              await this.reconcileTerminalState(rentalIdBigInt);
            } else {
              const failRes = await this.transitionJournal({
                targetStage: 'FAILED',
                identity,
                mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
              });
              if (failRes.ok) {
                this.settlement.stage = 'failed';
                this.settlement.failureReason = 'receipt_reverted';
              } else {
                this.settlement.failureReason = failRes.conflictReason;
                this.settlement.error = failRes.error;
              }
              this.error = this.settlement.error;
            }
          } catch (err: unknown) {
            this.settleSending = false;
            const classified = classifySubmissionError(err);
            if (classified.isDeterministic) {
              const failRes = await this.transitionJournal({
                targetStage: 'FAILED',
                identity,
                mutate: () => this.journal!.recordFailed(identity, { failureCode: classified.reason, ownerId: this.ownerId }),
              });
              if (failRes.ok) {
                this.settlement.stage = 'failed';
                this.settlement.failureReason = classified.reason;
              } else {
                this.settlement.failureReason = failRes.conflictReason;
                this.settlement.error = failRes.error;
              }
              this.error = this.settlement.error;
            } else {
              const retryRes = await this.transitionJournal({
                targetStage: 'RETRYABLE_FAILURE',
                identity,
                mutate: () => this.journal!.recordRetryableFailure(identity, {
                  failureCode: classified.reason,
                  nextRetryAtMs: Date.now() + this.settleBackoffMs(),
                  ownerId: this.ownerId,
                }),
                failureCode: classified.reason,
              });
              if (!retryRes.ok) {
                this.settlement.failureReason = retryRes.conflictReason;
                this.settlement.error = retryRes.error;
                this.error = retryRes.error;
              }
            }
          }
        }
        return;
      }

      // Case B: latest > stored (nonce has been mined)
      if (BigInt(latestCount) > storedNonce) {
        if (rental?.status === 'COMPLETED') {
          const minedRes = await this.transitionJournal({
            targetStage: 'MINED',
            identity,
            mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
          });
          if (!minedRes.ok) {
            this.settlement = {
              rentalId: rentalIdBigInt,
              stage: 'idle',
              failureReason: minedRes.conflictReason,
              error: minedRes.error,
              attempts: job.attempts,
              lastAttemptAtMs: Date.now(),
              retryAtMs: 0,
            };
            this.error = minedRes.error;
            return;
          }
          const recRes = await this.transitionJournal({
            targetStage: 'RECONCILING',
            identity,
            mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
          });
          if (!recRes.ok) {
            this.settlement = {
              rentalId: rentalIdBigInt,
              stage: 'idle',
              failureReason: recRes.conflictReason,
              error: recRes.error,
              attempts: job.attempts,
              lastAttemptAtMs: Date.now(),
              retryAtMs: 0,
            };
            this.error = recRes.error;
            return;
          }
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'reconciling',
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
          };
          await this.reconcileTerminalState(rentalIdBigInt);
        } else {
          const failRes = await this.transitionJournal({
            targetStage: 'FAILED',
            identity,
            mutate: () => this.journal!.recordFailed(identity, { failureCode: 'AMBIGUOUS_CONSUMED_NONCE', ownerId: this.ownerId }),
          });
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: failRes.ok ? 'failed' : 'idle',
            failureReason: failRes.ok ? 'never_submitted' : failRes.conflictReason,
            error: failRes.ok ? 'ambiguous consumed nonce: transaction with stored nonce already mined but rental not completed' : failRes.error,
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
          };
          this.error = this.settlement.error;
        }
        return;
      }

      // Case C: pending > stored && latest <= stored (pending in mempool)
      if (rental?.status === 'COMPLETED') {
        const minedRes = await this.transitionJournal({
          targetStage: 'MINED',
          identity,
          mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
        });
        if (!minedRes.ok) {
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'idle',
            failureReason: minedRes.conflictReason,
            error: minedRes.error,
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
          };
          this.error = minedRes.error;
          return;
        }
        const recRes = await this.transitionJournal({
          targetStage: 'RECONCILING',
          identity,
          mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
        });
        if (!recRes.ok) {
          this.settlement = {
            rentalId: rentalIdBigInt,
            stage: 'idle',
            failureReason: recRes.conflictReason,
            error: recRes.error,
            attempts: job.attempts,
            lastAttemptAtMs: Date.now(),
            retryAtMs: 0,
          };
          this.error = recRes.error;
          return;
        }
        this.settlement = {
          rentalId: rentalIdBigInt,
          stage: 'reconciling',
          attempts: job.attempts,
          lastAttemptAtMs: Date.now(),
          retryAtMs: 0,
        };
        await this.reconcileTerminalState(rentalIdBigInt);
      } else {
        const failRes = await this.transitionJournal({
          targetStage: 'FAILED',
          identity,
          mutate: () => this.journal!.recordFailed(identity, { failureCode: 'AMBIGUOUS_CONSUMED_NONCE', ownerId: this.ownerId }),
        });
        this.settlement = {
          rentalId: rentalIdBigInt,
          stage: failRes.ok ? 'failed' : 'idle',
          failureReason: failRes.ok ? 'never_submitted' : failRes.conflictReason,
          error: failRes.ok ? 'ambiguous consumed nonce: transaction with stored nonce pending in mempool' : failRes.error,
          attempts: job.attempts,
          lastAttemptAtMs: Date.now(),
          retryAtMs: 0,
        };
        this.error = this.settlement.error;
      }
      return;
    }

    // 5. If job is FAILED:
    if (job.stage === 'FAILED') {
      this.settlement = {
        rentalId: rentalIdBigInt,
        stage: 'failed',
        failureReason: (job.failureCode as SettlementFailureReason) ?? 'never_submitted',
        attempts: job.attempts,
        lastAttemptAtMs: job.updatedAtMs,
        retryAtMs: 0,
      };
      return;
    }
  }

  async run(): Promise<void> {
    if (this.journal && !this.recoveryRun) {
      this.recoveryRun = true;
      try {
        await this.journal.initialize();
        await this.runRecovery();
      } catch (err: unknown) {
        this.error = 'settlement journal initialization or recovery failed';
        throw err;
      }
    }
    while (!this.stopped) {
      const gate = Math.max(this.startBackoffMs(), this.settleBackoffMs());
      try {
        await this.tick();
      } catch {
        // The watcher must never die: a transient RPC outage becomes visible
        // via health, not a terminated process.
        this.error = 'authoritative reservation read or transition unavailable';
      }
      if (this.stopped) break;
      const delay = Math.max(this.watchIntervalMs, gate);
      try {
        await setTimeout(delay, undefined, { signal: this.abortController.signal });
      } catch {
        if (this.stopped) break;
      }
    }
  }

  /**
   * How long to wait before the next tick after a failed `startRental()`.
   */
  private startBackoffMs(): number {
    if (this.startFailures === 0) return 0;
    const backoff = this.watchIntervalMs * 2 ** (this.startFailures - 1);
    return Math.min(backoff, ReservationWatcher.MAX_BACKOFF_MS);
  }

  /**
   * True while a failed start's backoff window is still open.
   */
  private gateBlockedByBackoff(): boolean {
    return this.startFailures > 0 && Date.now() < this.startRetryAtMs;
  }

  /**
   * How long to wait before the next tick after a failed settlement attempt.
   */
  private settleBackoffMs(): number {
    if (this.settleFailures === 0) return 0;
    const delay = this.options.settleRetryDelayMs ?? 2000;
    const backoff = delay * 2 ** (this.settleFailures - 1);
    return Math.min(backoff, this.options.settleBackoffMaxMs ?? ReservationWatcher.MAX_BACKOFF_MS);
  }

  /**
   * True while a failed settlement's backoff window is still open.
   */
  private settleBlockedByBackoff(): boolean {
    return this.settleFailures > 0 && Date.now() < this.settleRetryAtMs;
  }

  reset(): void {
    this.rentalId = null;
    this.state = 'idle';
    this.error = undefined;
    this.startFailures = 0;
    this.startRetryAtMs = 0;
    this.recoveryRun = false;
    this.clearSettlement();
  }

  private clearSettlement(): void {
    this.settlement = null;
    this.settleSending = false;
    this.settleFailures = 0;
    this.settleRetryAtMs = 0;
  }

  private async tick(): Promise<void> {
    if (this.journal && !this.recoveryRun) {
      this.recoveryRun = true;
      await this.journal.initialize();
      await this.runRecovery();
    }
    const now = Math.floor(Date.now() / 1000);

    // 1. Look for a non-terminal rental for this node.
    const list = await this.client.getActiveRentalForNode(this.monitor.nodeId);
    if (!list) {
      // DEFECT 1: If occupancy is null and a settlement or tracked rental exists,
      // continue its existing state machine instead of discarding it!
      const targetRentalId = this.settlement?.rentalId ?? this.rentalId;
      if (targetRentalId) {
        if (this.settlement?.stage === 'submitted' && this.settlement.txHash) {
          const identity: SettlementJobIdentity = {
            chainId: this.monitor.config.chain.chainId,
            rentalManagerAddress: this.monitor.config.chain.rentalManagerAddress,
            rentalId: targetRentalId.toString(),
          };
          try {
            const receipt = await this.client.waitForTransactionSuccess(this.settlement.txHash as Hex);
            if (receipt.status !== 'success') {
              if (this.journal) {
                const failRes = await this.transitionJournal({
                  targetStage: 'FAILED',
                  identity,
                  mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
                });
                if (failRes.ok) {
                  this.settlement.stage = 'failed';
                  this.settlement.failureReason = 'receipt_reverted';
                } else {
                  this.settlement.failureReason = failRes.conflictReason;
                  this.settlement.error = failRes.error;
                }
              } else {
                this.settlement.stage = 'failed';
                this.settlement.failureReason = 'receipt_reverted';
              }
              this.settlement.error = 'settlement transaction reverted onchain';
              this.error = this.settlement.error;
              return;
            }
            if (this.journal) {
              const minedRes = await this.transitionJournal({
                targetStage: 'MINED',
                identity,
                mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
              });
              if (!minedRes.ok) {
                this.settlement.failureReason = minedRes.conflictReason;
                this.settlement.error = minedRes.error;
                this.error = minedRes.error;
                return;
              }
            }
            this.settlement.stage = 'mined';
          } catch (err: unknown) {
            const classified = classifyReceiptError(err);
            if (classified.isReverted) {
              if (this.journal) {
                const failRes = await this.transitionJournal({
                  targetStage: 'FAILED',
                  identity,
                  mutate: () => this.journal!.recordFailed(identity, { failureCode: 'receipt_reverted', ownerId: this.ownerId }),
                });
                if (failRes.ok) {
                  this.settlement.stage = 'failed';
                  this.settlement.failureReason = 'receipt_reverted';
                } else {
                  this.settlement.failureReason = failRes.conflictReason;
                  this.settlement.error = failRes.error;
                }
              } else {
                this.settlement.stage = 'failed';
                this.settlement.failureReason = 'receipt_reverted';
              }
              this.settlement.error = classified.safeMessage;
              this.error = this.settlement.error;
              return;
            }
            this.settlement.failureReason = 'receipt_pending';
            this.settlement.error = classified.safeMessage;
            this.error = this.settlement.error;
            return;
          }
        }

        if (
          this.settlement?.stage === 'mined' ||
          this.settlement?.stage === 'reconciling' ||
          this.settlement?.failureReason === 'reconciliation_pending'
        ) {
          await this.reconcileTerminalState(targetRentalId);
          return;
        }

        if (!this.settlement || this.settlement.stage === 'idle' || this.settlement.stage === 'preflight') {
          let finished: ChainRental | null = null;
          try {
            finished = await this.client.getRental(targetRentalId);
          } catch {
            // Occupancy and rental reads may briefly disagree across RPC
            // replicas. Preserve the tracked target and fail closed until an
            // authoritative rental read succeeds; clearing it here could hide
            // a settlement that still needs receipt/reconciliation work.
            this.error = 'authoritative rental read unavailable';
            return;
          }
          if (finished && finished.status === 'COMPLETED') {
            if (!this.settlement) {
              this.settlement = {
                rentalId: targetRentalId,
                stage: 'reconciling',
                attempts: 0,
                lastAttemptAtMs: 0,
                retryAtMs: 0,
              };
            }
            await this.reconcileTerminalState(targetRentalId, true);
            return;
          } else if (finished && finished.status === 'CANCELLED') {
            this.clearSettlement();
            this.rentalId = null;
            this.transition('idle');
            return;
          } else {
            this.clearSettlement();
            this.rentalId = null;
            this.transition('idle');
            return;
          }
        }

        if (this.settlement?.stage === 'failed') {
          this.rentalId = null;
          this.transition('idle');
          return;
        }
      }

      this.rentalId = null;
      this.transition('idle');
      return;
    }

    // 2. Read the canonical rental so status, timestamps and fields are
    //    consistent (list-view and single-view can diverge in block ordering).
    const rental = await this.client.getRental(list.rentalId);
    if (!rental) {
      if (!this.settlement) {
        this.transition('idle');
      }
      return;
    }

    // 3. Update the cached rental so the monitor and session store can derive
    //    authoritative timestamps without their own chain reads.
    this.monitor.updateCachedRental({
      rentalId: rental.rentalId,
      nodeId: rental.nodeId,
      expiresAt: Number(rental.expiresAt),
      startDeadline: Number(rental.startDeadline),
    });

    // 4. Terminal states end the reservation.
    if (rental.status === 'CANCELLED') {
      this.clearSettlement();
      this.transition('idle');
      return;
    }

    if (rental.status === 'COMPLETED') {
      if (this.settlement && this.settlement.rentalId === rental.rentalId) {
        await this.reconcileTerminalState(rental.rentalId);
      } else {
        this.clearSettlement();
        this.transition('idle');
      }
      return;
    }

    // 5. Unexpected status — do not silently auto-start or auto-settle.
    if (rental.status !== 'RESERVED' && rental.status !== 'ACTIVE') {
      this.clearSettlement();
      this.transition('idle');
      this.error = `rental ${rental.rentalId} has unexpected status ${rental.status}`;
      return;
    }

    // 6. Handle RESERVED status
    if (rental.status === 'RESERVED') {
      this.clearSettlement();
      if (this.rentalId !== rental.rentalId) {
        this.rentalId = rental.rentalId;
        this.error = undefined;
        this.startFailures = 0;
        this.startRetryAtMs = 0;
        this.transition('active');
        return;
      }

      if (this.state === 'active' && !this.gateBlockedByBackoff()) {
        await this.handleAutoStart(rental, now);
      }
      return;
    }

    // 7. Handle ACTIVE status
    if (rental.status === 'ACTIVE') {
      if (this.rentalId !== rental.rentalId) {
        this.rentalId = rental.rentalId;
        this.transition('ready');
      }

      // A terminal failure belongs to one rental only. Contract occupancy is
      // exclusive, so observing a different ACTIVE rental proves the old one
      // is no longer the node's live lease. Do not let rental A's failure
      // permanently block automatic settlement for rental B.
      if (this.settlement && this.settlement.rentalId !== rental.rentalId) {
        this.clearSettlement();
      }

      const isAutoSettleEnabled = this.autoSettlementEnabled;
      if (!isAutoSettleEnabled) {
        let blockTimestamp: bigint | null = null;
        try {
          blockTimestamp = await this.client.getBlockTimestamp();
        } catch {
          // ignore
        }
        const isExpired =
          (blockTimestamp !== null && rental.expiresAt && blockTimestamp >= rental.expiresAt) ||
          now >= Number(rental.expiresAt);
        if (isExpired && !this.settlement?.txHash) {
          this.settlement = {
            rentalId: rental.rentalId,
            stage: 'idle',
            attempts: 0,
            lastAttemptAtMs: 0,
            retryAtMs: 0,
            failureReason: 'AUTO_SETTLEMENT_DISABLED',
          };
        }
        return;
      }

      if (!rental.expiresAt || rental.expiresAt <= 0n) {
        this.error = 'auto-settle blocked: invalid expiresAt';
        return;
      }

      if (this.settleBlockedByBackoff() || this.settleSending || this.settlement?.stage === 'failed') {
        return;
      }

      let blockTimestamp: bigint;
      try {
        blockTimestamp = await this.client.getBlockTimestamp();
      } catch {
        this.settleFailures++;
        this.settleRetryAtMs = Date.now() + this.settleBackoffMs();
        this.error = 'transient authoritative-read failure: unable to read block timestamp';
        if (this.settlement) {
          this.settlement.failureReason = 'authoritative_read_failed';
          this.settlement.error = this.error;
        }
        return;
      }

      // DEFECT 2: Authoritative bigint comparison with chain block timestamp
      if (blockTimestamp >= rental.expiresAt) {
        await this.handleAutoSettle(rental, blockTimestamp);
      }
      return;
    }
  }

  private async handleAutoStart(rental: ChainRental, now: number): Promise<void> {
    if (!this.autoStartEnabled) {
      return;
    }
    if (rental.startDeadline <= now) {
      this.error = 'reservation missed its start deadline';
      this.startFailures = 0;
      return;
    }

    if (this.monitor.config.chain.chainId !== 46630) {
      this.error = `auto-start blocked: chainId ${this.monitor.config.chain.chainId} is not 46630`;
      return;
    }

    if (rental.nodeId !== 1n) {
      this.error = `auto-start blocked: node ${rental.nodeId} is not Node 1`;
      return;
    }

    if (!this.monitor.config.providerPrivateKey) {
      this.error = 'auto-start blocked: provider signer unavailable';
      return;
    }
    if (this.monitor.config.providerPrivateKey) {
      try {
        const signerAccount = privateKeyToAccount(this.monitor.config.providerPrivateKey as `0x${string}`);
        if (signerAccount.address.toLowerCase() !== rental.provider.toLowerCase()) {
          this.error = `auto-start blocked: provider signer ${signerAccount.address} does not match rental provider ${rental.provider}`;
          return;
        }
      } catch (e) {
        void e;
        this.error = 'auto-start blocked: provider signer invalid';
        return;
      }
    }

    // Health-check gate.
    const health = await this.monitor.checks();
    const required = ['agent', 'rpc', 'backend'];
    const failing = health.filter((c) => required.includes(c.name) && c.status !== 'ok');
    if (required.some((name) => !health.some((c) => c.name === name))) {
      this.error = 'auto-start blocked: required readiness checks missing';
      return;
    }
    if (failing.length > 0) {
      this.error = `auto-start blocked by ${failing.map((c) => c.name).join(', ')}`;
      return;
    }

    if (this.monitor.config.inferenceMode !== 'demo') {
      const gpuBlock = gpuAllowsStart(await this.monitor.readGpu(), this.monitor.config);
      if (gpuBlock) {
        this.error = `auto-start blocked: ${gpuBlock.message}`;
        return;
      }
    }

    // The agent calls startRental().
    try {
      const receipt = await this.client.startRental(rental.rentalId);
      this.error = undefined;
      this.startFailures = 0;
      await this.monitor.onRentalStarted(rental.rentalId, receipt);

      // Re-read rental from chain to verify ACTIVE status before marking ready
      const updated = await this.client.getRental(rental.rentalId);
      if (updated && updated.status === 'ACTIVE') {
        this.transition('ready');
      } else {
        this.error = `rental ${rental.rentalId} status is not ACTIVE after start`;
      }
    } catch (error) {
      this.startFailures += 1;
      this.startRetryAtMs = Date.now() + this.startBackoffMs();
      this.error =
        `startRental attempt ${this.startFailures} failed: ` +
        'transaction preflight or execution failed';
    }
  }

  private async handleAutoSettle(rental: ChainRental, _blockTimestamp: bigint): Promise<void> {
    if (!this.autoSettlementEnabled) {
      if (!this.settlement || this.settlement.rentalId !== rental.rentalId) {
        this.clearSettlement();
        this.settlement = {
          rentalId: rental.rentalId,
          stage: 'idle',
          attempts: 0,
          lastAttemptAtMs: 0,
          retryAtMs: 0,
          failureReason: 'AUTO_SETTLEMENT_DISABLED',
        };
      }
      this.transition('idle');
      return;
    }

    const identity: SettlementJobIdentity = {
      chainId: this.monitor.config.chain.chainId,
      rentalManagerAddress: this.monitor.config.chain.rentalManagerAddress,
      rentalId: rental.rentalId.toString(),
    };

    if (this.journal) {
      const job = await this.journal.createOrLoadJob(identity, {
        nodeId: this.monitor.nodeId.toString(),
        ownerId: this.ownerId,
        claimExpiresAtMs: Date.now() + this.claimLeaseMs,
      });

      const claimed = await this.journal.claimJob(
        identity,
        this.ownerId,
        Date.now() + this.claimLeaseMs,
      );
      if (!claimed) {
        return;
      }

      if (job.stage === 'CONFIRMED') {
        this.clearSettlement();
        this.transition('idle');
        return;
      }

      if (job.stage === 'FAILED') {
        this.settlement = {
          rentalId: rental.rentalId,
          stage: 'failed',
          failureReason: (job.failureCode as SettlementFailureReason) ?? 'never_submitted',
          attempts: job.attempts,
          lastAttemptAtMs: job.updatedAtMs,
          retryAtMs: 0,
        };
        return;
      }

      if (job.stage === 'SUBMITTED' && job.txHash) {
        if (!this.settlement) {
          this.settlement = {
            rentalId: rental.rentalId,
            stage: 'submitted',
            txHash: job.txHash as Hex,
            attempts: job.attempts,
            lastAttemptAtMs: job.updatedAtMs,
            retryAtMs: 0,
          };
        } else {
          this.settlement.txHash = job.txHash as Hex;
          this.settlement.stage = 'submitted';
        }
      } else if (job.stage === 'MINED' || job.stage === 'RECONCILING') {
        if (!this.settlement) {
          this.settlement = {
            rentalId: rental.rentalId,
            stage: 'reconciling',
            txHash: (job.txHash as Hex) ?? undefined,
            attempts: job.attempts,
            lastAttemptAtMs: job.updatedAtMs,
            retryAtMs: 0,
          };
        } else {
          this.settlement.stage = 'reconciling';
        }
      }
    }

    // Reset settlement if rentalId changed
    if (!this.settlement || this.settlement.rentalId !== rental.rentalId) {
      this.clearSettlement();
      this.settlement = {
        rentalId: rental.rentalId,
        stage: 'idle',
        attempts: 0,
        lastAttemptAtMs: 0,
        retryAtMs: 0,
      };
    }

    this.rentalId = rental.rentalId;

    // Concurrency guard: if a send is currently in progress, do nothing
    if (this.settleSending) {
      return;
    }

    // Permanent failure guard: do not retry if in terminal failure stage
    if (this.settlement.stage === 'failed') {
      return;
    }

    // Backoff gate: if in backoff window, do nothing
    if (this.settleBlockedByBackoff()) {
      return;
    }

    // Max attempts ceiling: do not retry forever
    const maxAttempts = this.options.maxSettleAttempts ?? 5;
    if (this.settleFailures >= maxAttempts) {
      this.error = 'auto-settle permanently failed after max retries';
      if (this.journal) {
        const failRes = await this.transitionJournal({
          targetStage: 'FAILED',
          identity,
          mutate: () => this.journal!.recordFailed(identity, {
            failureCode: 'never_submitted',
            ownerId: this.ownerId,
          }),
        });
        this.settlement = {
          rentalId: rental.rentalId,
          stage: failRes.ok ? 'failed' : 'idle',
          failureReason: failRes.ok ? 'never_submitted' : failRes.conflictReason,
          error: failRes.ok ? this.error : failRes.error,
          attempts: this.settleFailures,
          lastAttemptAtMs: Date.now(),
          retryAtMs: 0,
        };
        this.error = this.settlement.error;
      } else {
        this.settlement.stage = 'failed';
        this.settlement.error = this.error;
        this.settlement.failureReason = 'never_submitted';
      }
      return;
    }

    // Stage: 'idle' -> Preflight and Submit
    if (this.settlement.stage === 'idle') {
      this.settleSending = true;
      this.settlement.stage = 'preflight';
      this.settlement.attempts++;
      this.settlement.lastAttemptAtMs = Date.now();
      this.transition('settling');

      // 1. Preflight sequence:
      // - chain ID === 46630
      if (this.monitor.config.chain.chainId !== 46630) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.error = `auto-settle blocked: chainId ${this.monitor.config.chain.chainId} is not 46630`;
        return;
      }

      let currentOcc: ChainRental | null = null;
      let freshRental: ChainRental | null = null;
      let currentBlockTimestamp: bigint;

      try {
        [currentOcc, freshRental, currentBlockTimestamp] = await Promise.all([
          this.client.getActiveRentalForNode(this.monitor.nodeId),
          this.client.getRental(rental.rentalId),
          this.client.getBlockTimestamp(),
        ]);
      } catch {
        this.settleSending = false;
        this.settleFailures++;
        this.settleRetryAtMs = Date.now() + this.settleBackoffMs();
        this.error = 'transient authoritative-read failure: preflight read failed';
        this.settlement.stage = 'idle';
        this.settlement.failureReason = 'authoritative_read_failed';
        this.settlement.error = this.error;
        return;
      }

      // - canonical occupancy references target rental
      if (!currentOcc || currentOcc.rentalId !== rental.rentalId) {
        this.settleSending = false;
        if (freshRental && freshRental.status === 'COMPLETED') {
          await this.reconcileTerminalState(rental.rentalId, true);
        } else {
          this.settlement.stage = 'idle';
        }
        return;
      }

      // - fresh rental exists
      if (!freshRental) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        return;
      }

      // - rental.nodeId === configured Node 1
      if (freshRental.nodeId !== this.monitor.nodeId || freshRental.nodeId !== 1n) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.error = `auto-settle blocked: node ${freshRental.nodeId} is not Node 1`;
        return;
      }

      // - rental.status === ACTIVE
      if (freshRental.status !== 'ACTIVE') {
        this.settleSending = false;
        if (freshRental.status === 'COMPLETED') {
          await this.reconcileTerminalState(rental.rentalId, true);
        } else {
          this.settlement.stage = 'idle';
        }
        return;
      }

      // - rental.expiresAt > 0n
      if (freshRental.expiresAt <= 0n) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.error = 'auto-settle blocked: invalid expiresAt';
        return;
      }

      // - blockTimestamp >= rental.expiresAt (bigint comparison)
      if (currentBlockTimestamp < freshRental.expiresAt) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        return;
      }

      // Transaction signer availability
      const hasSigner =
        this.client.hasProviderWallet || Boolean(this.monitor.config.providerPrivateKey);
      if (!hasSigner) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.error = 'auto-settle blocked: provider signer unavailable';
        return;
      }

      // - encoded target equals configured RentalManager
      const encoded = this.client.encodeSettleAfterExpiryCalldata(rental.rentalId);
      if (
        !encoded.to ||
        encoded.to.toLowerCase() !== this.monitor.config.chain.rentalManagerAddress.toLowerCase()
      ) {
        this.settleSending = false;
        const err = 'encoded target does not match configured RentalManager';
        if (this.journal) {
          const failRes = await this.transitionJournal({
            targetStage: 'FAILED',
            identity,
            mutate: () => this.journal!.recordFailed(identity, {
              failureCode: 'simulation_reverted',
              ownerId: this.ownerId,
            }),
          });
          this.settlement.stage = failRes.ok ? 'failed' : 'idle';
          this.settlement.failureReason = failRes.ok ? 'simulation_reverted' : failRes.conflictReason;
          this.settlement.error = failRes.ok ? err : failRes.error;
        } else {
          this.settlement.stage = 'failed';
          this.settlement.failureReason = 'simulation_reverted';
          this.settlement.error = err;
        }
        this.error = this.settlement.error;
        return;
      }

      // - encoded value === 0n
      if (encoded.value !== 0n) {
        this.settleSending = false;
        const err = 'encoded value must be 0n';
        if (this.journal) {
          const failRes = await this.transitionJournal({
            targetStage: 'FAILED',
            identity,
            mutate: () => this.journal!.recordFailed(identity, {
              failureCode: 'submission_rejected',
              ownerId: this.ownerId,
            }),
          });
          this.settlement.stage = failRes.ok ? 'failed' : 'idle';
          this.settlement.failureReason = failRes.ok ? 'submission_rejected' : failRes.conflictReason;
          this.settlement.error = failRes.ok ? err : failRes.error;
        } else {
          this.settlement.stage = 'failed';
          this.settlement.failureReason = 'submission_rejected';
          this.settlement.error = err;
        }
        this.error = this.settlement.error;
        return;
      }

      // Explicit sender address and nonce tracking
      let senderAddress: string | undefined;
      const resolved = this.getResolvedProviderAddress();
      if (resolved) {
        senderAddress = resolved;
      } else if (this.monitor.config?.providerPrivateKey) {
        try {
          senderAddress = privateKeyToAccount(this.monitor.config.providerPrivateKey as `0x${string}`).address;
        } catch {
          // ignore
        }
      }

      // Hard gate 1: If journal configured, provider sender address is mandatory
      if (this.journal && !senderAddress) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.settlement.failureReason = 'JOURNAL_PERSISTENCE_FAILED';
        this.settlement.error = 'missing provider sender address for durable settlement';
        this.error = this.settlement.error;
        return;
      }

      // Hard gate 2: If journal configured, getTransactionCount is mandatory
      if (this.journal && typeof this.client.getTransactionCount !== 'function') {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.settlement.failureReason = 'JOURNAL_PERSISTENCE_FAILED';
        this.settlement.error = 'missing getTransactionCount for durable settlement';
        this.error = this.settlement.error;
        return;
      }

      let nonce: number | undefined;
      if (senderAddress && this.client.getTransactionCount) {
        try {
          nonce = await this.client.getTransactionCount(senderAddress as Address, 'pending');
        } catch {
          this.settleSending = false;
          this.settleFailures++;
          this.settleRetryAtMs = Date.now() + this.settleBackoffMs();
          this.error = 'transient authoritative-read failure: nonce lookup failed';
          this.settlement.stage = 'idle';
          this.settlement.failureReason = 'authoritative_read_failed';
          this.settlement.error = this.error;
          return;
        }
      }

      // Hard gate 3: If journal configured, pending nonce read must succeed
      if (this.journal && nonce === undefined) {
        this.settleSending = false;
        this.settlement.stage = 'idle';
        this.settlement.failureReason = 'JOURNAL_PERSISTENCE_FAILED';
        this.settlement.error = 'pending nonce lookup failed';
        this.error = this.settlement.error;
        return;
      }

      // Hard gate 4: Durable claim must be held / renewed
      if (this.journal) {
        const claimOk = await this.ensureClaimRenewed(identity);
        if (!claimOk) {
          this.settleSending = false;
          this.settlement.stage = 'idle';
          this.settlement.failureReason = 'JOURNAL_TRANSITION_CONFLICT';
          this.settlement.error = 'settlement lease lost before broadcast';
          this.error = this.settlement.error;
          return;
        }
      }

      // Hard gate 5: recordPreparing must return true
      if (this.journal && senderAddress && nonce !== undefined) {
        const prepRes = await this.transitionJournal({
          targetStage: 'PREPARING',
          identity,
          mutate: () => this.journal!.recordPreparing(identity, {
            senderAddress,
            transactionNonce: String(nonce),
            ownerId: this.ownerId,
          }),
          expectedSender: senderAddress,
          expectedNonce: String(nonce),
        });
        if (!prepRes.ok) {
          this.settleSending = false;
          this.settlement.stage = 'idle';
          this.settlement.failureReason = prepRes.conflictReason;
          this.settlement.error = prepRes.error;
          this.error = this.settlement.error;
          return;
        }

        // Hard gate 6: Reread journal must show:
        // - stage PREPARING;
        // - correct sender;
        // - correct nonce;
        // - current claim owner;
        const reread = await this.journal.getJob(identity);
        if (
          !reread ||
          reread.stage !== 'PREPARING' ||
          reread.senderAddress?.toLowerCase() !== senderAddress.toLowerCase() ||
          reread.transactionNonce !== String(nonce) ||
          reread.claimOwner !== this.ownerId
        ) {
          this.settleSending = false;
          this.settlement.stage = 'idle';
          this.settlement.failureReason = 'JOURNAL_PERSISTENCE_FAILED';
          this.settlement.error = 'settlement journal PREPARING record mismatch';
          this.error = this.settlement.error;
          return;
        }
      }

      try {
        const txHash = await this.safeSubmitTransaction(
          encoded,
          nonce !== undefined ? { nonce } : undefined,
        );
        if (this.journal) {
          const subRes = await this.transitionJournal({
            targetStage: 'SUBMITTED',
            identity,
            mutate: () => this.journal!.recordSubmitted(identity, {
              txHash,
              ownerId: this.ownerId,
            }),
            expectedTxHash: txHash,
          });
          this.settlement.txHash = txHash;
          this.settleSending = false;
          if (!subRes.ok) {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = subRes.conflictReason;
            this.settlement.error = subRes.error;
            this.error = subRes.error;
            return;
          }
          this.settlement.stage = 'submitted';
          this.error = undefined;
        } else {
          this.settlement.txHash = txHash;
          this.settlement.stage = 'submitted';
          this.error = undefined;
        }
      } catch (err: unknown) {
        const classified = classifySubmissionError(err);
        if (classified.isDeterministic) {
          if (this.journal) {
            const failRes = await this.transitionJournal({
              targetStage: 'FAILED',
              identity,
              mutate: () => this.journal!.recordFailed(identity, {
                failureCode: classified.reason,
                ownerId: this.ownerId,
              }),
            });
            this.settlement.stage = failRes.ok ? 'failed' : 'idle';
            this.settlement.failureReason = failRes.ok ? classified.reason : failRes.conflictReason;
            this.settlement.error = failRes.ok ? classified.safeMessage : failRes.error;
            this.stopClaimRenewal();
          } else {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = classified.reason;
            this.settlement.error = classified.safeMessage;
          }
          this.error = this.settlement.error;
          return;
        }
        this.settleFailures++;
        this.settleRetryAtMs = Date.now() + this.settleBackoffMs();
        if (this.journal) {
          const retryRes = await this.transitionJournal({
            targetStage: 'RETRYABLE_FAILURE',
            identity,
            mutate: () => this.journal!.recordRetryableFailure(identity, {
              failureCode: classified.reason,
              nextRetryAtMs: this.settleRetryAtMs,
              ownerId: this.ownerId,
            }),
            failureCode: classified.reason,
          });
          if (!retryRes.ok) {
            this.settleFailures--;
            this.settlement.stage = 'idle';
            this.settlement.failureReason = retryRes.conflictReason;
            this.settlement.error = retryRes.error;
            this.error = this.settlement.error;
            return;
          }
        }
        this.settlement.stage = 'idle';
        this.settlement.failureReason = classified.reason;
        this.settlement.error = classified.safeMessage;
        this.error = this.settlement.error;
        return;
      } finally {
        this.settleSending = false;
      }
    }

    // Stage: 'submitted' -> wait for mined success receipt
    if (this.settlement.stage === 'submitted' && this.settlement.txHash) {
      try {
        if (this.journal && !(await this.ensureClaimRenewed(identity))) {
          return;
        }
        const receipt = await this.client.waitForTransactionSuccess(this.settlement.txHash);
        if (receipt.status !== 'success') {
          if (this.journal) {
            const failRes = await this.transitionJournal({
              targetStage: 'FAILED',
              identity,
              mutate: () => this.journal!.recordFailed(identity, {
                failureCode: 'receipt_reverted',
                ownerId: this.ownerId,
              }),
            });
            this.settlement.stage = failRes.ok ? 'failed' : 'idle';
            this.settlement.failureReason = failRes.ok ? 'receipt_reverted' : failRes.conflictReason;
            this.settlement.error = failRes.ok ? 'settlement transaction reverted onchain' : failRes.error;
            this.stopClaimRenewal();
          } else {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = 'receipt_reverted';
            this.settlement.error = 'settlement transaction reverted onchain';
          }
          this.error = this.settlement.error;
          return;
        }
        if (this.journal) {
          const minedRes = await this.transitionJournal({
            targetStage: 'MINED',
            identity,
            mutate: () => this.journal!.recordMined(identity, { ownerId: this.ownerId }),
          });
          if (!minedRes.ok) {
            this.settlement.failureReason = minedRes.conflictReason;
            this.settlement.error = minedRes.error;
            this.error = minedRes.error;
            return;
          }
          this.settlement.stage = 'mined';
        } else {
          this.settlement.stage = 'mined';
        }
      } catch (err: unknown) {
        const classified = classifyReceiptError(err);
        if (classified.isReverted) {
          if (this.journal) {
            const failRes = await this.transitionJournal({
              targetStage: 'FAILED',
              identity,
              mutate: () => this.journal!.recordFailed(identity, {
                failureCode: 'receipt_reverted',
                ownerId: this.ownerId,
              }),
            });
            this.settlement.stage = failRes.ok ? 'failed' : 'idle';
            this.settlement.failureReason = failRes.ok ? 'receipt_reverted' : failRes.conflictReason;
            this.settlement.error = failRes.ok ? classified.safeMessage : failRes.error;
            this.stopClaimRenewal();
          } else {
            this.settlement.stage = 'failed';
            this.settlement.failureReason = 'receipt_reverted';
            this.settlement.error = classified.safeMessage;
          }
          this.error = this.settlement.error;
          return;
        }
        // Receipt timeout / network error: retain known hash, keep checking receipt, do not resend
        this.settlement.failureReason = 'receipt_pending';
        this.settlement.error = classified.safeMessage;
        this.error = this.settlement.error;
        return;
      }
    }

    // Stage: 'mined' or 'reconciling' -> strict 3-point reconciliation
    if (this.settlement.stage === 'mined' || this.settlement.stage === 'reconciling') {
      if (this.journal) {
        if (!(await this.ensureClaimRenewed(identity))) {
          return;
        }
        const recRes = await this.transitionJournal({
          targetStage: 'RECONCILING',
          identity,
          mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
          fromStage: this.settlement.stage.toUpperCase(),
        });
        if (!recRes.ok) {
          this.settlement.failureReason = recRes.conflictReason;
          this.settlement.error = recRes.error;
          this.error = recRes.error;
          return;
        }
        this.settlement.stage = 'reconciling';
      }
      await this.reconcileTerminalState(rental.rentalId);
    }
  }

  private async reconcileTerminalState(
    targetRentalId: bigint,
    isSettledByOther = false,
  ): Promise<void> {
    if (!this.settlement) return;
    this.settlement.stage = 'reconciling';

    const identity: SettlementJobIdentity = {
      chainId: this.monitor.config.chain.chainId,
      rentalManagerAddress: this.monitor.config.chain.rentalManagerAddress,
      rentalId: targetRentalId.toString(),
    };

    if (this.journal) {
      if (!(await this.ensureClaimRenewed(identity))) {
        return;
      }
    }

    let freshRental: ChainRental | null = null;
    let activeOcc: ChainRental | null = null;
    let listing: ChainListing | null = null;

    try {
      [freshRental, activeOcc, listing] = await Promise.all([
        this.client.getRental(targetRentalId),
        this.client.getActiveRentalForNode(this.monitor.nodeId),
        this.client.getListing(this.monitor.nodeId),
      ]);
    } catch {
      this.settlement.failureReason = 'reconciliation_pending';
      this.settlement.error = 'terminal reconciliation pending';
      this.error = this.settlement.error;
      if (this.journal) {
        const recRes = await this.transitionJournal({
          targetStage: 'RECONCILING',
          identity,
          mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
          fromStage: 'RECONCILING',
        });
        if (!recRes.ok) {
          this.settlement.failureReason = recRes.conflictReason;
          this.settlement.error = recRes.error;
          this.error = recRes.error;
        }
      }
      return;
    }

    const isTerminalCompleted = freshRental !== null && freshRental.status === 'COMPLETED';
    const isUnoccupied = activeOcc === null;
    const isListingAvailable =
      listing !== null &&
      listing.nodeId === this.monitor.nodeId &&
      listing.active === true;

    if (isTerminalCompleted && isUnoccupied && isListingAvailable) {
      if (this.journal) {
        const confRes = await this.transitionJournal({
          targetStage: 'CONFIRMED',
          identity,
          mutate: () => this.journal!.recordConfirmed(identity, { ownerId: this.ownerId }),
        });
        if (!confRes.ok) {
          this.settlement.failureReason = confRes.conflictReason;
          this.settlement.error = confRes.error;
          this.error = confRes.error;
          return;
        }
        this.stopClaimRenewal();
      }
      this.settlement.stage = 'confirmed';
      if (isSettledByOther) {
        this.settlement.failureReason = 'settled_by_other';
      }
      this.clearSettlement();
      this.rentalId = null;
      this.transition('idle');
      this.error = undefined;
    } else {
      this.settlement.failureReason = 'reconciliation_pending';
      this.settlement.error = 'terminal reconciliation pending';
      this.error = this.settlement.error;
      if (this.journal) {
        const recRes = await this.transitionJournal({
          targetStage: 'RECONCILING',
          identity,
          mutate: () => this.journal!.recordReconciling(identity, { ownerId: this.ownerId }),
          fromStage: 'RECONCILING',
        });
        if (!recRes.ok) {
          this.settlement.failureReason = recRes.conflictReason;
          this.settlement.error = recRes.error;
          this.error = recRes.error;
        }
      }
    }
  }


  private transition(next: ReservationState): void {
    this.state = next;
    this.error = undefined;
    this.startFailures = 0;
    this.startRetryAtMs = 0;
  }

  private startDeadline(): number {
    if (this.state === 'active' || this.state === 'ready') {
      const cached = this.monitor.cachedRental;
      if (cached && cached.startDeadline > 0) return cached.startDeadline;
    }
    return 0;
  }

  private expiresAt(): number {
    if (this.state === 'active' || this.state === 'ready' || this.state === 'settling') {
      const cached = this.monitor.cachedRental;
      if (cached && cached.expiresAt > 0) return cached.expiresAt;
    }
    return 0;
  }
}
