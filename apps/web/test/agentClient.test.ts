/**
 * Unit tests for agentClient.ts.
 *
 * Verifies:
 * 1. agentOrigin routing: local development (localhost / 127.0.0.1) -> port 8787,
 *    production -> same-origin private OmniRoute reverse proxy, with no fallback
 *    to public tunnels or guessed hosts.
 * 2. loadAbi: loads from web asset origin, normalizes array and object ABIs,
 *    and fails closed on 404, 500, network error, invalid JSON, or missing P0 methods.
 * 3. parseSession wire purity: rejects wire whitespace, leading zeros, explicit signs,
 *    unsafe integers, and non-canonical payloads.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  AgentError,
  agentOrigin,
  loadAbi,
  parseSession,
} from '../src/agentClient.js';
import { AbiError } from '../src/config.js';

// Minimal mock ABI containing the 11 required P0 methods
const VALID_P0_ABI = [
  { type: 'function', name: 'getNode', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getListing', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getPlan', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'planCount', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'activeRentalForNode', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getRental', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'paymentToken', inputs: [], outputs: [] },
  { type: 'function', name: 'rent', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'startRental', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancelExpiredReservation', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'settleAfterExpiry', inputs: [{ type: 'uint256' }], outputs: [] },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agentOrigin', () => {
  it('routes localhost to http://localhost:8787 regardless of page port', () => {
    assert.equal(
      agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
      'http://localhost:8787',
    );
  });

  it('routes 127.0.0.1 to http://127.0.0.1:8787 regardless of page port', () => {
    assert.equal(
      agentOrigin({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' }),
      'http://127.0.0.1:8787',
    );
  });

  it('routes production hosts to location.origin (private OmniRoute reverse proxy)', () => {
    assert.equal(
      agentOrigin({ hostname: 'app.archcore.local', origin: 'https://app.archcore.local' }),
      'https://app.archcore.local',
    );
    assert.equal(
      agentOrigin({ hostname: 'omniroute.private.network', origin: 'https://omniroute.private.network' }),
      'https://omniroute.private.network',
    );
    assert.equal(
      agentOrigin({ hostname: 'gateway.internal', origin: 'http://gateway.internal:8080' }),
      'http://gateway.internal:8080',
    );
  });

  it('never outputs public tunnel domains or guessed addresses', () => {
    const origin = agentOrigin({ hostname: 'app.archcore.internal', origin: 'https://app.archcore.internal' });
    assert.doesNotMatch(origin, /tailscale/i);
    assert.doesNotMatch(origin, /ngrok/i);
    assert.doesNotMatch(origin, /trycloudflare/i);
    assert.equal(origin, 'https://app.archcore.internal');
  });

  it('query parameter agentOrigin is ignored even on localhost', () => {
    assert.equal(
      agentOrigin({
        hostname: 'localhost',
        origin: 'http://localhost:3000',
        search: '?agentOrigin=http%3A%2F%2F127.0.0.1%3A41923',
      }),
      'http://localhost:8787',
    );
  });

  it('exact global http://127.0.0.1:<numeric-port> accepted', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'http://127.0.0.1:52111';
    try {
      assert.equal(
        agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
        'http://127.0.0.1:52111',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('exact global http://localhost:<numeric-port> accepted', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'http://localhost:49152';
    try {
      assert.equal(
        agentOrigin({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:3000' }),
        'http://localhost:49152',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('userinfo @evil bypass rejected', () => {
    const evilCases = [
      'http://127.0.0.1:80@evil.example',
      'http://localhost:80@evil.example',
      'http://user:pass@127.0.0.1:8000',
    ];
    for (const evil of evilCases) {
      (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = evil;
      try {
        assert.equal(
          agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
          'http://localhost:8787',
          `Expected ${evil} to be rejected`,
        );
      } finally {
        delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
      }
    }
  });

  it('subdomain-suffix bypass rejected', () => {
    const suffixCases = [
      'http://127.0.0.1.evil.example:8000',
      'http://localhost.evil.example:8000',
    ];
    for (const suffix of suffixCases) {
      (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = suffix;
      try {
        assert.equal(
          agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
          'http://localhost:8787',
          `Expected ${suffix} to be rejected`,
        );
      } finally {
        delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
      }
    }
  });

  it('HTTPS rejected', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'https://127.0.0.1:8000';
    try {
      assert.equal(
        agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
        'http://localhost:8787',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('path rejected', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'http://127.0.0.1:8000/path';
    try {
      assert.equal(
        agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
        'http://localhost:8787',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('query rejected', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'http://127.0.0.1:8000?query=yes';
    try {
      assert.equal(
        agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
        'http://localhost:8787',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('fragment rejected', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'http://127.0.0.1:8000#fragment';
    try {
      assert.equal(
        agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
        'http://localhost:8787',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('missing port rejected', () => {
    for (const missingPort of ['http://127.0.0.1', 'http://localhost']) {
      (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = missingPort;
      try {
        assert.equal(
          agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
          'http://localhost:8787',
          `Expected ${missingPort} to be rejected`,
        );
      } finally {
        delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
      }
    }
  });

  it('malformed URL rejected', () => {
    const malformed = [
      'not-a-valid-url',
      'javascript:alert(1)',
      'data:text/html,evil',
      'file:///etc/passwd',
      '',
    ];
    for (const bad of malformed) {
      (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = bad;
      try {
        assert.equal(
          agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
          'http://localhost:8787',
          `Expected ${bad} to be rejected`,
        );
      } finally {
        delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
      }
    }
  });

  it('production hostname ignores every global override', () => {
    (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__ = 'http://127.0.0.1:52111';
    try {
      assert.equal(
        agentOrigin({
          hostname: 'app.archcore.production',
          origin: 'https://app.archcore.production',
          search: '?agentOrigin=http%3A%2F%2F127.0.0.1%3A41923',
        }),
        'https://app.archcore.production',
      );
    } finally {
      delete (globalThis as any).__ARCHCORE_TEST_AGENT_ORIGIN__;
    }
  });

  it('fallback remains http://localhost:8787 or http://127.0.0.1:8787 according to page hostname', () => {
    assert.equal(
      agentOrigin({ hostname: 'localhost', origin: 'http://localhost:3000' }),
      'http://localhost:8787',
    );
    assert.equal(
      agentOrigin({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:3000' }),
      'http://127.0.0.1:8787',
    );
  });
});

describe('loadAbi', () => {
  it('loads and normalises ABI array from webAssetOrigin', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://web.archcore.local/rental-manager.json');
      return jsonResponse(200, VALID_P0_ABI);
    });
    try {
      const abi = await loadAbi('https://web.archcore.local');
      assert.equal(abi.length, 11);
      assert.ok(abi.some((entry) => entry.name === 'activeRentalForNode'));
      assert.ok(abi.some((entry) => entry.name === 'getNode'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('loads and normalises ABI object { abi: [...] } from webAssetOrigin', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      assert.equal(String(url), 'https://web.archcore.local/rental-manager.json');
      return jsonResponse(200, { abi: VALID_P0_ABI });
    });
    try {
      const abi = await loadAbi('https://web.archcore.local');
      assert.equal(abi.length, 11);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fails closed on 404 response', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response('Not Found', { status: 404 }));
    try {
      await assert.rejects(
        () => loadAbi('https://web.archcore.local'),
        (err: unknown) => err instanceof AbiError && /HTTP 404/i.test(err.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fails closed on 500 response', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response('Server Error', { status: 500 }));
    try {
      await assert.rejects(
        () => loadAbi('https://web.archcore.local'),
        (err: unknown) => err instanceof AbiError && /HTTP 500/i.test(err.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fails closed on network failure', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    try {
      await assert.rejects(
        () => loadAbi('https://web.archcore.local'),
        (err: unknown) => err instanceof AbiError && /Cannot reach RentalManager ABI/i.test(err.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fails closed on non-JSON response', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response('<html>Error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    try {
      await assert.rejects(
        () => loadAbi('https://web.archcore.local'),
        (err: unknown) => err instanceof AbiError && /not valid JSON/i.test(err.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('fails closed when ABI artifact is missing required P0 methods', async () => {
    const incompleteAbi = VALID_P0_ABI.filter((entry) => entry.name !== 'activeRentalForNode');
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => jsonResponse(200, incompleteAbi));
    try {
      await assert.rejects(
        () => loadAbi('https://web.archcore.local'),
        (err: unknown) => err instanceof AbiError && /missing the rental methods: activeRentalForNode/i.test(err.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('parseSession wire purity edge cases', () => {
  it('rejects wire whitespace in rentalId (leading, trailing, or internal)', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: ' 7 ', expiresAt: '1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed or non-positive decimal rentalId/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7 ', expiresAt: '1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed or non-positive decimal rentalId/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: ' 7', expiresAt: '1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed or non-positive decimal rentalId/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '\t7\n', expiresAt: '1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed or non-positive decimal rentalId/i.test(err.message),
    );
  });

  it('rejects wire whitespace in expiresAt (leading, trailing, or internal)', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: ' 1790000000 ' }),
      (err: unknown) => err instanceof AgentError && /malformed decimal string for expiresAt/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '1790000000 ' }),
      (err: unknown) => err instanceof AgentError && /malformed decimal string for expiresAt/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: ' 1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed decimal string for expiresAt/i.test(err.message),
    );
  });

  it('rejects leading zeros in rentalId and expiresAt', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '07', expiresAt: '1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed or non-positive decimal rentalId/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '01790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed decimal string for expiresAt/i.test(err.message),
    );
  });

  it('rejects explicit positive signs in rentalId and expiresAt', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '+7', expiresAt: '1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed or non-positive decimal rentalId/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '+1790000000' }),
      (err: unknown) => err instanceof AgentError && /malformed decimal string for expiresAt/i.test(err.message),
    );
  });

  it('rejects timestamps that exceed safe integer range or represent milliseconds', () => {
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '9007199254740992' }),
      (err: unknown) => err instanceof AgentError && /zero or invalid expiresAt/i.test(err.message),
    );
    assert.throws(
      () => parseSession({ token: 'tok', rentalId: '7', expiresAt: '1790000000000' }),
      (err: unknown) => err instanceof AgentError && /millisecond timestamp/i.test(err.message),
    );
  });
});
