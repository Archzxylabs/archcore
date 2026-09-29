/**
 * Health-response tests.
 *
 * These are isolated unit tests with a stubbed `fetch`. They are not a live
 * Agent check: nothing here talks to the operator's tunnel, and a passing run
 * says only that the renter classifies the responses it was handed.
 *
 * The regression they exist for: the Agent answers `503` with a JSON body whose
 * `status` can still read `ok`. Treating "the body parsed" as healthy is how a
 * degraded node gets a Rent button.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { AgentError, fetchHealth } from '../src/agentClient.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchHealth', () => {
  it('reads a 200 with every check passing as healthy', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () =>
      jsonResponse(200, { status: 'ok', checks: [{ name: 'gpu', status: 'ok' }] }),
    );
    try {
      const health = await fetchHealth('http://agent.invalid');
      assert.equal(health.status, 'ok');
      assert.equal(health.checks.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('treats a 503 as degraded even when the body says ok', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () =>
      jsonResponse(503, {
        status: 'ok',
        checks: [{ name: 'ollama', status: 'error', detail: 'unreachable' }],
      }),
    );
    try {
      const health = await fetchHealth('http://agent.invalid');
      assert.equal(health.status, 'degraded');
      assert.equal(health.checks[0]?.name, 'ollama');
      assert.match(health.checks[0]?.detail ?? '', /unreachable/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('treats every other non-2xx status as degraded', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => jsonResponse(500, { status: 'ok', checks: [] }));
    try {
      const health = await fetchHealth('http://agent.invalid');
      assert.equal(health.status, 'degraded');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('degrades a non-2xx response whose body is not JSON', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response('bad gateway', { status: 502 }));
    try {
      const health = await fetchHealth('http://agent.invalid');
      assert.equal(health.status, 'degraded');
      assert.match(health.checks[0]?.detail ?? '', /HTTP 502/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('throws, rather than reporting healthy, when the agent cannot be reached', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError('network down');
    });
    try {
      await assert.rejects(() => fetchHealth('http://agent.invalid'), AgentError);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
