/**
 * Inference assembly and streaming tests.
 *
 * Two bugs this suite exists to catch, both of which the previous page had:
 *
 * 1. **Appending `complete`.** A `complete` frame carries the whole answer. If
 *    it is appended to the streamed text, the answer ends with its last sentence
 *    repeated — which reads as a corruption, not as a duplication the renter
 *    would notice as a bug symptom.
 * 2. **Dropping a frame that arrives with no trailing blank line.** The agent
 *    aborts its own generation at its ceiling and at the lease end; the text that
 *    arrived before either is the answer the renter paid for.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { InferenceAssembler, InferenceError, isSessionDead, streamInference } from '../src/inference.js';

function encode(frames: readonly string[]): Uint8Array {
  return new TextEncoder().encode(frames.join(''));
}

function sseResponse(frames: readonly string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encode([frame]));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}


describe('InferenceAssembler', () => {
  it('revokes access immediately on an expiry SSE error, but not a generation timeout', () => {
    const assembler = new InferenceAssembler();
    assert.throws(() => assembler.apply({ type: 'error', code: 'ABORTED_AT_EXPIRY', message: 'expired' }),
      (error: unknown) => error instanceof InferenceError && isSessionDead(error));
    assert.equal(isSessionDead(new InferenceError('timeout', 'INFERENCE_FAILED')), false);
  });
  it('concatenates deltas in arrival order', () => {
    const assembler = new InferenceAssembler();
    assert.equal(assembler.apply({ type: 'delta', output: 'Hello, ' }), 'Hello, ');
    assert.equal(assembler.apply({ type: 'delta', output: 'world' }), 'Hello, world');
    assert.equal(assembler.output, 'Hello, world');
  });

  it('replaces, never appends, on a complete frame', () => {
    // This is the duplication regression: the correct answer appears exactly
    // once, ending at its final character.
    const assembler = new InferenceAssembler();
    assembler.apply({ type: 'delta', output: 'The answer' });
    const final = assembler.apply({ type: 'complete', output: 'The answer is 42.' });
    assert.equal(final, 'The answer is 42.');
    assert.equal(assembler.output, 'The answer is 42.');
    // The streamed prefix must not survive anywhere in the result as a repeat.
    assert.equal(assembler.output.indexOf('The answer is 42.'), 0);
  });

  it('clears the text when a complete frame carries no output', () => {
    const assembler = new InferenceAssembler();
    assembler.apply({ type: 'delta', output: 'partial' });
    assert.equal(assembler.apply({ type: 'complete', output: null }), '');
  });

  it('throws on an error frame, carrying the code and message', () => {
    const assembler = new InferenceAssembler();
    assembler.apply({ type: 'delta', output: 'half an ans' });
    assert.throws(
      () => assembler.apply({ type: 'error', code: 'RATE_LIMITED', message: 'too many' }),
      (error: unknown) =>
        error instanceof InferenceError
        && error.message.includes('RATE_LIMITED')
        && error.message.includes('too many'),
    );
  });
});

describe('streamInference', () => {
  it('sends only a prompt and the bearer token', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return sseResponse(['event: delta\ndata: {"output":"ok"}\n\nevent: complete\ndata: {"output":"ok"}\n\n']);
    }) as unknown as typeof fetch;

    try {
      const out: string[] = [];
      for await (const text of streamInference('http://agent', 'tok', { prompt: 'hi' }, new AbortController().signal)) {
        out.push(text);
      }
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.url, 'http://agent/v1/inference');
      assert.equal(seen[0]!.init.method, 'POST');
      const headers = seen[0]!.init.headers as Record<string, string>;
      assert.equal(headers.authorization, 'Bearer tok');
      // `model`, `options`, `system` and `messages` are all rejected by the
      // agent with 400, so their absence here is what keeps the request valid.
      assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { prompt: 'hi' });
      // The delta yields once, then the complete frame replaces the same text.
      assert.deepEqual(out, ['ok', 'ok']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('assembles a stream that arrives in small pieces', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => sseResponse(
      ['event: delta\ndata: {"output":"Hello, "}\n\n', 'event: delta\ndata: {"output":"world."}\n\n', 'event: complete\ndata: {"output":"Hello, world."}\n\n'],
    )) as unknown as typeof fetch;
    try {
      const out: string[] = [];
      const controller = new AbortController();
      // Yield the same final text at each step; the last one is authoritative.
      for await (const text of streamInference('http://agent', 'tok', { prompt: 'x' }, controller.signal)) {
        out.push(text);
      }
      assert.deepEqual(out, ['Hello, ', 'Hello, world.', 'Hello, world.']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('ends with the complete frame replacing the assembled text', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => sseResponse([
      'event: delta\ndata: {"output":"Hello, "}\n\n',
      'event: delta\ndata: {"output":"world."}\n\n',
      'event: complete\ndata: {"output":"Hello, world. Done."}\n\n',
    ])) as unknown as typeof fetch;
    try {
      const out: string[] = [];
      for await (const text of streamInference('http://agent', 'tok', { prompt: 'x' }, new AbortController().signal)) {
        out.push(text);
      }
      assert.equal(out.at(-1), 'Hello, world. Done.');
      assert.equal(out.length, 3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('preserves partial text but fails closed when the stream has no terminal event', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => sseResponse([
      'event: delta\ndata: {"output":"I was cut "}\n\n',
      'event: delta\ndata: {"output":"off"}',
    ])) as unknown as typeof fetch;
    try {
      const out: string[] = [];
      await assert.rejects(async () => {
        for await (const text of streamInference('http://agent', 'tok', { prompt: 'x' }, new AbortController().signal)) out.push(text);
      }, /without a terminal complete/);
      assert.equal(out.at(-1), 'I was cut off');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws when the agent rejects the session with 401', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    try {
      const controller = new AbortController();
      await assert.rejects(
        async () => {
          for await (const _ of streamInference('http://agent', 'dead', { prompt: 'x' }, controller.signal)) void _;
        },
        (error: unknown) =>
          error instanceof Error
          // The caller forgets the token on an AgentError from status 401 or 409,
          // so what matters is that it is that type, not its wording.
          && error.name === 'AgentError'
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports a 409 rental change as a dead session, not a stream failure', async () => {
    // The renter's rental was re-rented or cancelled while this page was open, so
    // the token the UI still holds is no longer the Agent's. The caller must be
    // able to forget it: an InferenceError here would be read as a retryable
    // failure, and the retry would be rejected with the same 409 forever.
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response('rental changed', { status: 409 })) as unknown as typeof fetch;
    try {
      const controller = new AbortController();
      await assert.rejects(
        async () => {
          for await (const _ of streamInference('http://agent', 'stale', { prompt: 'x' }, controller.signal)) void _;
        },
        (error: unknown) =>
          error instanceof Error
          && error.name === 'AgentError'
          && (error as { status?: number }).status === 409
          && isSessionDead(error),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('surfaces an error frame as a failure', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => sseResponse([
      'event: error\ndata: {"code":"RATE_LIMITED","error":"one GPU, one rental"}\n\n',
    ])) as unknown as typeof fetch;
    try {
      await assert.rejects(
        async () => {
          for await (const _ of streamInference('http://agent', 'tok', { prompt: 'x' }, new AbortController().signal)) void _;
        },
        (error: unknown) => error instanceof InferenceError && error.message.includes('RATE_LIMITED'),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('ends quietly when the caller aborts the stream', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mock.fn((_input: string | URL | Request, init?: RequestInit) => {
      // A stream that only ever produces the first frame, so the abort is what
      // ends the generator.
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    try {
      const controller = new AbortController();
      const out: string[] = [];
      const iterate = (async () => {
        for await (const text of streamInference('http://agent', 'tok', { prompt: 'x' }, controller.signal)) {
          out.push(text);
        }
      })();
      controller.abort();
      // A stop is the renter's action; it must resolve, not reject.
      await iterate;
      assert.deepEqual(out, []);
    } finally {
      globalThis.fetch = original;
    }
  });
});
