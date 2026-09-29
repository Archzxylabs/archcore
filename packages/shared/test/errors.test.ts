import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArchcoreError, ErrorCode, ERROR_CATALOG, protocolError, toSafeError } from '../src/errors';

describe('canonical safe protocol error catalogue', () => {
  it('maps every code once and preserves the frozen two-field envelope', () => {
    assert.deepEqual(Object.keys(ERROR_CATALOG).sort(), Object.values(ErrorCode).sort());
    for (const code of Object.values(ErrorCode)) {
      const safe = protocolError(code);
      assert.equal(safe.status, ERROR_CATALOG[code].status);
      assert.deepEqual(Object.keys(safe.body).sort(), ['code', 'error']);
    }
  });
  it('uses fixed auth and dependency statuses, never route-local guesses', () => {
    for (const [code, status] of [['INVALID_SIGNATURE', 401], ['CHALLENGE_NOT_FOUND', 404],
      ['CHALLENGE_EXPIRED', 408], ['CHALLENGE_REPLAYED', 409], ['SESSION_EXPIRED', 409],
      ['RPC_UNAVAILABLE', 503], ['DEPENDENCY_UNAVAILABLE', 503]] as const) assert.equal(protocolError(code).status, status);
    assert.equal(new ArchcoreError(ErrorCode.INVALID_SIGNATURE, 'private exception', 200).statusCode, 401);
  });
  it('collapses unknown failures to safe INTERNAL 500 without exception data', () => {
    assert.deepEqual(protocolError('unknown-provider-code'), { status: 500, body: { code: 'INTERNAL', error: 'An internal error occurred.' } });
    assert.deepEqual(toSafeError(new Error('credentialed endpoint and raw exception')), { code: 'INTERNAL', message: 'An internal error occurred.' });
  });
});
