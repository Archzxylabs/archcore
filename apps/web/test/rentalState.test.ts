/**
 * Rental lifecycle tests.
 *
 * Every button the page shows is one of these predicates, so each of them is the
 * difference between an action the contract accepts and one it reverts. The
 * cases that matter are the boundaries, and the confusion this suite exists to
 * prevent: a RESERVED rental the provider has not started must never be offered
 * as usable, because the agent refuses a challenge for it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canBeStarted,
  canCancelExpired,
  canSettleExpired,
  emptyRental,
  formatDeadline,
  isAccessible,
  isNone,
  isOwned,
  lifecycleStage,
  secondsRemaining,
} from '../src/rentalState.js';
import type { ChainRental } from '../src/chainPure.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const NOW = 1_700_000_000_000; // ms
const NOW_S = BigInt(Math.floor(NOW / 1000));

function rental(overrides: Partial<ChainRental> = {}): ChainRental {
  return {
    rentalId: 7n,
    nodeId: 1n,
    renter: ACCOUNT,
    provider: '0x3333333333333333333333333333333333333333',
    priceAtomic: 100000n,
    planId: 0,
    durationSeconds: 300n,
    status: 'ACTIVE',
    startDeadline: 0n,
    startsAt: NOW_S - 60n,
    expiresAt: NOW_S + 3600n,
    createdAt: NOW_S - 120n,
    raw: {},
    ...overrides,
  };
}

describe('emptyRental / isNone', () => {
  it('is NONE and holds the zero address', () => {
    const empty = emptyRental();
    assert.equal(isNone(empty), true);
    assert.equal(empty.renter, '0x0000000000000000000000000000000000000000');
    // No deadline may be read as "available": a zero timestamp is not a date.
    assert.equal(empty.expiresAt, 0n);
  });

  it('treats a live rental as not-none', () => {
    assert.equal(isNone(rental()), false);
  });
});

describe('isOwned', () => {
  it('accepts the renter regardless of address casing', () => {
    assert.equal(
      isOwned(rental({ renter: `${ACCOUNT.toUpperCase().replace('0X', '0x')}` as `0x${string}` }), ACCOUNT),
      true,
    );
  });

  it('rejects a rental held by someone else', () => {
    assert.equal(isOwned(rental({ renter: OTHER }), ACCOUNT), false);
  });

  it('rejects the empty rental', () => {
    assert.equal(isOwned(emptyRental(), ACCOUNT), false);
  });
});

describe('canBeStarted', () => {
  it('is true while a RESERVED rental sits inside its grace window', () => {
    const reserved = rental({ status: 'RESERVED', startDeadline: NOW_S + 60n, startsAt: 0n });
    assert.equal(canBeStarted(reserved, NOW), true);
  });

  it('is false once the start deadline has passed', () => {
    const reserved = rental({ status: 'RESERVED', startDeadline: NOW_S - 1n, startsAt: 0n });
    assert.equal(canBeStarted(reserved, NOW), false);
  });

  it('is false for an ACTIVE rental', () => {
    assert.equal(canBeStarted(rental({ status: 'ACTIVE' }), NOW), false);
  });

  it('is false when the deadline was never set', () => {
    // A zero deadline is "unknown", and unknown must not read as "still time".
    assert.equal(canBeStarted(rental({ status: 'RESERVED', startDeadline: 0n }), NOW), false);
  });
});

describe('canCancelExpired', () => {
  it('is true for a RESERVED rental that missed its start deadline', () => {
    const missed = rental({ status: 'RESERVED', startDeadline: NOW_S - 1n, startsAt: 0n });
    assert.equal(canCancelExpired(missed, NOW), true);
  });

  it('is false while the rental could still be started', () => {
    const live = rental({ status: 'RESERVED', startDeadline: NOW_S + 60n });
    assert.equal(canCancelExpired(live, NOW), false);
  });
});

describe('canSettleExpired', () => {
  it('is true for an ACTIVE rental past its expiry', () => {
    const expired = rental({ status: 'ACTIVE', expiresAt: NOW_S - 1n });
    assert.equal(canSettleExpired(expired, NOW), true);
  });

  it('is false while the rental is still running', () => {
    assert.equal(canSettleExpired(rental({ status: 'ACTIVE' }), NOW), false);
  });
});

describe('isAccessible', () => {
  it('is true inside the access window', () => {
    assert.equal(isAccessible(rental(), NOW), true);
  });

  it('is false before the rental has started', () => {
    const starting = rental({ startsAt: NOW_S + 600n });
    assert.equal(isAccessible(starting, NOW), false);
  });

  it('is false after the rental has expired', () => {
    assert.equal(isAccessible(rental({ expiresAt: NOW_S - 1n }), NOW), false);
  });

  it('is false for a RESERVED rental', () => {
    // The regression this guards: a reservation the provider has not started
    // looks live on screen but the agent will refuse a challenge for it.
    const reserved = rental({
      status: 'RESERVED',
      startsAt: NOW_S - 60n,
      startDeadline: NOW_S + 60n,
    });
    assert.equal(isAccessible(reserved, NOW), false);
  });

  it('fails closed for a zero or inverted expiry', () => {
    assert.equal(isAccessible(rental({ expiresAt: 0n }), NOW), false);
    assert.equal(isAccessible(rental({ expiresAt: NOW_S - 61n }), NOW), false);
  });
});

describe('lifecycleStage', () => {
  it('reports none for a node with no rental', () => {
    assert.equal(lifecycleStage(emptyRental(), ACCOUNT, NOW), 'none');
  });

  it('reports foreign for a rental held by another account', () => {
    assert.equal(lifecycleStage(rental({ renter: OTHER }), ACCOUNT, NOW), 'foreign');
  });

  it('reports reserved while the start window is open', () => {
    const reserved = rental({ status: 'RESERVED', startDeadline: NOW_S + 60n, startsAt: 0n });
    assert.equal(lifecycleStage(reserved, ACCOUNT, NOW), 'reserved');
  });

  it('reports expired once the start window has closed', () => {
    const missed = rental({ status: 'RESERVED', startDeadline: NOW_S - 1n, startsAt: 0n });
    assert.equal(lifecycleStage(missed, ACCOUNT, NOW), 'expired');
  });

  it('reports active while the rental runs', () => {
    assert.equal(lifecycleStage(rental(), ACCOUNT, NOW), 'active');
  });

  it('reports expired once the rental has run out', () => {
    const burnt = rental({ expiresAt: NOW_S - 1n });
    assert.equal(lifecycleStage(burnt, ACCOUNT, NOW), 'expired');
  });

  it('reports settled and cancelled once the contract says so', () => {
    assert.equal(lifecycleStage(rental({ status: 'COMPLETED' }), ACCOUNT, NOW), 'settled');
    assert.equal(lifecycleStage(rental({ status: 'CANCELLED' }), ACCOUNT, NOW), 'cancelled');
  });

  it('advances a rental from reserved to expired as the clock moves', () => {
    // The reason every predicate takes `nowMs`: a page left open must not keep
    // offering a startable reservation after its deadline.
    const reserved = rental({ status: 'RESERVED', startDeadline: NOW_S + 10n, startsAt: 0n });
    assert.equal(lifecycleStage(reserved, ACCOUNT, NOW), 'reserved');
    assert.equal(lifecycleStage(reserved, ACCOUNT, NOW + 11_000), 'expired');
  });
});

describe('formatDeadline', () => {
  it('shows a placeholder for an unset deadline', () => {
    assert.equal(formatDeadline(0n), '—');
  });

  it('formats a set deadline as a time', () => {
    const formatted = formatDeadline(NOW_S);
    assert.ok(formatted.length > 0);
    assert.notEqual(formatted.trim(), '—');
  });
});

describe('secondsRemaining', () => {
  it('counts down to zero and stops there', () => {
    assert.equal(secondsRemaining(NOW_S + 30n, NOW), 30);
    assert.equal(secondsRemaining(NOW_S - 30n, NOW), 0);
  });

  it('is zero for an unset deadline', () => {
    assert.equal(secondsRemaining(0n, NOW), 0);
  });

  it('counts a whole number of seconds, dropping the fraction', () => {
    assert.equal(secondsRemaining(NOW_S + 1n, NOW + 500), 1);
  });
});
