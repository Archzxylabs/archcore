/**
 * SSE parser tests.
 *
 * The parser is where a truncated stream becomes a wrong answer, so the cases
 * that matter are the boundary ones: a frame split across chunks, several frames
 * in one chunk, a multi-byte character cut mid-sequence, and a stream that ends
 * before its final blank line.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SseError, SseParser, parseFrame } from '../src/sse.js';

/** Feeds chunks through one parser and collects every event, in order. */
function events(chunks: readonly string[]): ReturnType<SseParser['push']> {
  const parser = new SseParser();
  const out: ReturnType<SseParser['push']> = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  return out;
}

const delta = (output: string): string => `event: delta\ndata: {"output":"${output}"}\n\n`;
const complete = (output: string): string => `event: complete\ndata: {"output":"${output}"}\n\n`;

describe('SseParser.push', () => {
  it('emits nothing until the blank line closes a frame', () => {
    assert.deepEqual(events([delta('a').trimEnd()]), []);
    assert.equal(events([delta('a')]).length, 1);
  });

  it('reassembles a frame split across chunks', () => {
    const frame = delta('hello');
    const cut = Math.floor(frame.length / 2);
    const parsed = events([frame.slice(0, cut), frame.slice(cut)]);
    assert.deepEqual(parsed, [{ type: 'delta', output: 'hello' }]);
  });

  it('keeps several frames from one chunk in arrival order', () => {
    assert.deepEqual(events([delta('a') + delta('b')]), [
      { type: 'delta', output: 'a' },
      { type: 'delta', output: 'b' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const parsed = events(['event: delta\r\ndata: {"output":"crlf"}\r\n\r\n']);
    assert.deepEqual(parsed, [{ type: 'delta', output: 'crlf' }]);
  });

  it('joins a multi-line data payload as one document', () => {
    const parsed = events(['event: delta\ndata: {"output":\ndata: "line"}\n\n']);
    assert.deepEqual(parsed, [{ type: 'delta', output: 'line' }]);
  });

  it('ignores comment lines', () => {
    assert.deepEqual(events([': keep-alive\n\n']), []);
  });

  it('ignores unknown event names rather than failing', () => {
    assert.deepEqual(events(['event: ping\ndata: {"output":"x"}\n\n']), []);
  });

  it('throws on a data line that is not JSON', () => {
    assert.throws(() => events([delta('x') + 'event: delta\ndata: not-json\n\n']), SseError);
  });

  it('does not emit a delta with no output', () => {
    // An empty delta carries no text; emitting it would append "" and make the
    // caller believe a frame had arrived.
    assert.deepEqual(events(['event: delta\ndata: {"other":1}\n\n']), []);
  });
});

describe('SseParser.end', () => {
  it('flushes a frame the stream closed without its blank line', () => {
    // The agent can be cut off mid-frame by its own generation cap; the text
    // that did arrive must still reach the renter.
    const parser = new SseParser();
    assert.deepEqual(parser.push('event: delta\ndata: {"output":"tail"}'), []);
    assert.deepEqual(parser.end(), [{ type: 'delta', output: 'tail' }]);
  });

  it('is empty when the buffer holds nothing', () => {
    assert.deepEqual(new SseParser().end(), []);
  });
});

describe('parseFrame', () => {
  it('labels a complete frame', () => {
    assert.deepEqual(parseFrame('event: complete\ndata: {"output":"done"}'), {
      type: 'complete',
      output: 'done',
    });
  });

  it('labels an error frame with its code and message', () => {
    assert.deepEqual(parseFrame('event: error\ndata: {"code":"RATE_LIMITED","error":"slow down"}'), {
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'slow down',
    });
  });

  it('defaults an unspecified error code', () => {
    const parsed = parseFrame('event: error\ndata: {"error":"boom"}');
    assert.deepEqual(parsed, { type: 'error', code: 'INFERENCE_FAILED', message: 'boom' });
  });
});

describe('frame sequences from the real agent', () => {
  it('streams deltas that a complete frame then replaces', () => {
    const parsed = events([delta('Hello, ') + delta('world.') + complete('Hello, world.')]);
    assert.equal(parsed.length, 3);
    assert.equal(parsed.at(-1)?.type, 'complete');
    // The assembler replaces on `complete`; the test for that lives with the
    // assembler, but this proves the three frames survive the transport.
  });
});
