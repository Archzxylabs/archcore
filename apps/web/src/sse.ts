/**
 * Server-Sent Events parser for the inference stream.
 *
 * The Agent emits frames of the form:
 *
 *   event: delta\n
 *   data: {"output":"chunk"}\n
 *   \n
 *
 * Three properties of the real transport are handled explicitly:
 *
 * 1. **Chunks are arbitrary.** A single `read()` can carry any number of
 *    frames, or half of one. Bytes are buffered until a blank line completes a
 *    frame, so a split boundary is never parsed early.
 * 2. **`data` may be multiline.** Each `data:` line of one frame is concatenated
 *    with `\n` per the SSE spec and parsed as one JSON document, so a pretty
 *    printed payload is not read as two invalid fragments.
 * 3. **Several events can share a chunk.** Every completed frame is returned in
 *    arrival order rather than only the first.
 *
 * The assembled text is only ever the concatenation of `delta` outputs; the
 * authoritative `complete` output *replaces* it, which is why the caller must
 * not also append `complete` — that would duplicate the tail of the answer.
 */

/** An inference event understood by the renter UI. */
export type InferenceEvent =
  | { type: 'delta'; output: string }
  | { type: 'complete'; output: string | null }
  | { type: 'error'; code: string; message: string };

export class SseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseError';
  }
}

/** Incremental parser: `push()` bytes, `end()` the leftovers. */
export class SseParser {
  private buffer = '';

  /**
   * Feeds a decoded chunk and returns every frame it completed, in order.
   *
   * A trailing partial frame stays in the buffer; it is resolved by the next
   * `push()` or by `end()`.
   */
  push(chunk: string): InferenceEvent[] {
    this.buffer += chunk;
    // SSE separates frames with a blank line. `\r\n\r\n` is normalised so a
    // CRLF transport does not leave a stray `\r` inside the JSON payload.
    const normalised = this.buffer.replace(/\r\n/g, '\n');
    const boundary = normalised.indexOf('\n\n');
    if (boundary === -1) {
      this.buffer = normalised;
      return [];
    }
    const frames = normalised.split('\n\n');
    this.buffer = frames.pop() ?? '';
    const events: InferenceEvent[] = [];
    for (const frame of frames) {
      const event = parseFrame(frame);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** Flushes a trailing frame the stream closed without the final blank line. */
  end(): InferenceEvent[] {
    const remainder = this.buffer.replace(/\r\n/g, '\n').trim();
    this.buffer = '';
    if (remainder.length === 0) return [];
    const event = parseFrame(remainder);
    return event === null ? [] : [event];
  }
}

/**
 * Turns one complete frame into an event, or `null` when it carries nothing the
 * renter UI acts on (comments, keep-alives, unknown event names).
 */
export function parseFrame(frame: string): InferenceEvent | null {
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      // Per the SSE spec only one leading space after the colon is stripped.
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    // Other field names (`id:`, `retry:`) carry no inference payload.
  }

  const payload = dataLines.join('\n');
  if (payload.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new SseError('Inference stream sent a data line that is not JSON.');
  }

  const record = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const errorCode = typeof (record as { code?: unknown }).code === 'string'
    ? (record as { code: string }).code
    : 'INFERENCE_FAILED';
  const errorMessage = typeof (record as { error?: unknown }).error === 'string'
    ? (record as { error: string }).error
    : 'stream failed';
  const output = typeof (record as { output?: unknown }).output === 'string'
    ? (record as { output: string }).output
    : null;

  switch (eventName) {
    case 'delta':
      // A delta without text is a transport hiccup, not an empty answer, so the
      // assembled text is left untouched rather than reset.
      return output === null ? null : { type: 'delta', output };
    case 'complete':
      return { type: 'complete', output };
    case 'error':
      return { type: 'error', code: errorCode, message: errorMessage };
    default:
      return null;
  }
}
