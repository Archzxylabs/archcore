import { ArchcoreError, ErrorCode, type ResourceLimits } from '@archcore/shared';

/**
 * Handle for one claimed generation slot.
 *
 * The handle is the unit of cleanup: it remembers the lease that claimed the
 * slot and frees it at most once, whatever the code path — success, upstream
 * error, timeout, or client abort. Callers that hold it must call `release()`
 * in their `finally`; callers that only know the rental id use
 * `RentalQuota.release(rentalId)`, which stays available for compatibility.
 */
export interface QuotaLease {
  /** Rental the slot was claimed for. */
  readonly rentalId: bigint;
  /** Monotonic lease counter, unique per acquire of this rental. */
  readonly leaseId: number;
  /** Frees the slot. Safe to call more than once. */
  release(): void;
}

interface RentalUsage {
  /** Generations counted for this rental. */
  count: number;
  /** Wall-clock ms of the most recent acquire. */
  lastAtMs: number;
  /** True while a generation is running. */
  inFlight: boolean;
  /** Lease counter of the generation currently running, if any. */
  activeLeaseId?: number;
  /**
   * Unix seconds when this rental's access ends, when the caller supplied it.
   * Undefined for callers that only pass identity, which keeps the entry
   * age-bounded by `maxRequestsPerRental` alone.
   */
  expiresAtSec?: number;
}

/**
 * Per-rental inference quota and concurrency guard.
 *
 * P0 freezes three ceilings: at most `maxRequestsPerRental` generations per
 * rental, at least `minRequestIntervalSeconds` between two of them, and at most
 * `maxConcurrentInference` live generations for the whole agent (P0 = 1). The
 * concurrency ceiling is global — one generation anywhere in the agent fills
 * the slot, whichever rental it belongs to.
 *
 * Every check and every mutation happens synchronously inside `acquire()`, and
 * no `await` sits between them. JavaScript runs one task at a time, so two
 * concurrent `POST /v1/inference` calls cannot both observe "no generation in
 * flight" — the second one sees the flag the first one already set and is
 * rejected with 429. That is what makes the guard parallel-safe without a mutex
 * or a lock file.
 */
export class RentalQuota {
  private readonly usage = new Map<string, RentalUsage>();
  private nextLeaseId = 1;

  /**
   * Generations running right now, across every rental. The ceiling is global
   * (P0 = 1): a second request is refused while any rental still has one live,
   * whichever rental owns it.
   */
  private liveGenerations = 0;

  constructor(private readonly limits: ResourceLimits) {}

  /**
   * Counts one request and claims the single generation slot, returning the
   * lease that frees it.
   *
   * Throws `ArchcoreError` with 429 when any ceiling is hit, so the caller must
   * never reach the backend. A successful acquire is always balanced by a
   * `release()`/`release(rentalId)` in the caller's `finally` block — including
   * on failure, abort and client disconnect — otherwise one crashed generation
   * wedges the node until the process restarts.
   *
   * `expiresAtSec` is optional so existing callers that pass only
   * `(rentalId, nowMs)` keep working; when given, it makes cleanup
   * deterministic, because a rental whose lease has ended can be dropped even
   * if the process never observed its stream finishing.
   */
  acquire(rentalId: bigint, nowMs: number = Date.now(), expiresAtSec?: number): QuotaLease {
    const key = rentalId.toString();
    const entry = this.usage.get(key);

    if (this.liveGenerations >= this.limits.maxConcurrentInference) {
      throw new ArchcoreError(
        ErrorCode.CONCURRENCY_LIMIT,
        `only ${this.limits.maxConcurrentInference} generation(s) may run at a time`,
        429,
      );
    }

    if (entry && entry.count >= this.limits.maxRequestsPerRental) {
      throw new ArchcoreError(
        ErrorCode.RATE_LIMITED,
        `rental already used ${entry.count} of ${this.limits.maxRequestsPerRental} requests`,
        429,
      );
    }

    const minSpacingMs = this.limits.minRequestIntervalSeconds * 1000;
    if (entry && nowMs - entry.lastAtMs < minSpacingMs) {
      throw new ArchcoreError(
        ErrorCode.RATE_LIMITED,
        `requests must be ${this.limits.minRequestIntervalSeconds}s apart`,
        429,
      );
    }

    const leaseId = this.nextLeaseId++;

    if (entry) {
      entry.count += 1;
      entry.lastAtMs = nowMs;
      entry.inFlight = true;
      entry.activeLeaseId = leaseId;
      if (expiresAtSec !== undefined) entry.expiresAtSec = expiresAtSec;
    } else {
      this.usage.set(key, {
        count: 1,
        lastAtMs: nowMs,
        inFlight: true,
        activeLeaseId: leaseId,
        expiresAtSec,
      });
    }
    this.liveGenerations += 1;

    let released = false;
    return {
      rentalId,
      leaseId,
      release: () => {
        // Exactly once, even when the caller's `finally` also runs: a double
        // release would decrement `liveGenerations` twice and let a second
        // generation onto a GPU slot that is still occupied.
        if (released) return;
        released = true;
        this.releaseLease(rentalId, leaseId);
      },
    };
  }

  /**
   * Frees the generation slot of a specific lease.
   *
   * A stale handle — one whose lease has already been replaced by a newer
   * acquire — is ignored, so a late `finally` can never release a slot that now
   * belongs to somebody else.
   */
  private releaseLease(rentalId: bigint, leaseId: number): void {
    const entry = this.usage.get(rentalId.toString());
    if (!entry || !entry.inFlight) return;
    if (entry.activeLeaseId !== undefined && entry.activeLeaseId !== leaseId) return;
    entry.inFlight = false;
    entry.activeLeaseId = undefined;
    this.liveGenerations = Math.max(0, this.liveGenerations - 1);
  }

  /**
   * Frees the generation slot by rental id alone.
   *
   * Kept for callers that do not hold a lease handle. It only ever frees the
   * lease that is currently running, never a newer one.
   */
  release(rentalId: bigint): void {
    const entry = this.usage.get(rentalId.toString());
    if (!entry || !entry.inFlight) return;
    const leaseId = entry.activeLeaseId;
    if (leaseId === undefined) {
      entry.inFlight = false;
      this.liveGenerations = Math.max(0, this.liveGenerations - 1);
      return;
    }
    this.releaseLease(rentalId, leaseId);
  }

  /** Requests counted so far, for `/gpu/status` style reporting. */
  used(rentalId: bigint): number {
    return this.usage.get(rentalId.toString())?.count ?? 0;
  }

  /** True while a generation for this rental is running. */
  busy(rentalId: bigint): boolean {
    return this.usage.get(rentalId.toString())?.inFlight ?? false;
  }

  /**
   * Drops usage state for every rental that is no longer being served.
   *
   * Called at expiry and whenever the active lease changes, so a finished
   * rental cannot keep pushing out a new one's budget. An entry whose recorded
   * `expiresAtSec` has passed is dropped even without a caller telling us the
   * lease changed: the chain has already ended it, so its counters are
   * meaningless. Entries with a generation in flight are never dropped — the
   * running lease still owns its slot.
   */
  sweep(activeRentalId: bigint | null, nowSec: number = Math.floor(Date.now() / 1000)): void {
    const active = activeRentalId?.toString() ?? null;
    for (const [key, entry] of this.usage) {
      if (entry.inFlight) continue;
      if (entry.expiresAtSec !== undefined && entry.expiresAtSec <= nowSec) {
        this.usage.delete(key);
        continue;
      }
      if (key !== active) this.usage.delete(key);
    }
  }

  /** How many generations are currently in-flight across all rentals. */
  activeGenerations(): number {
    return this.liveGenerations;
  }

  /** Test/diagnostics helper: how many rentals currently hold state. */
  size(): number {
    return this.usage.size;
  }
}
