/**
 * Inference over the frozen SSE contract.
 *
 * The text the renter sees is assembled from `delta` frames only. A `complete`
 * frame is authoritative and *replaces* the assembled text — so it must not be
 * appended, or the last sentence appears twice. An `error` frame is the only
 * thing that ends the stream with a failure: dropping the connection kills the
 * generator, but "no more frames" is not an error when the last one was
 * `complete`.
 *
 * The request is aborted in one place (`AbortController`) and that signal also
 * cancels the `fetch`, so stopping the stream stops the connection to the agent
 * rather than leaving it to finish writing into an unread reader.
 */

import { AgentError, isSessionDead as agentSessionDead } from './agentClient';
import { SseParser, type InferenceEvent } from './sse';

export class InferenceError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'InferenceError';
  }
}

/**
 * The only field the Agent accepts.
 *
 * `model`, `baseUrl`, `system`, `messages`, and `options.num_predict` are all
 * rejected with 400 — the node's model and its generation ceiling are the
 * operator's decisions, and accepting them from a caller would let a renter
 * redirect a paid rental to an endpoint of their choosing. The renter therefore
 * sends nothing but a prompt.
 */
export interface InferenceRequest {
  prompt: string;
}

/** Assembles the answer as frames arrive, replacing on `complete`. */
export class InferenceAssembler {
  private text = '';

  /** Applies one frame and returns the text to render. */
  apply(event: InferenceEvent): string {
    if (event.type === 'delta') {
      this.text += event.output;
      return this.text;
    }
    if (event.type === 'complete') {
      // `complete` is the whole answer, not its tail. Replacing avoids showing
      // the streamed prefix followed by the full answer, which reads as a
      // duplicated paragraph.
      this.text = event.output ?? '';
      return this.text;
    }
    throw new InferenceError(`${event.code}: ${event.message}`, event.code);
  }

  get output(): string {
    return this.text;
  }
}

/**
 * Streams inference and yields the assembled text after each frame.
 *
 * The caller decides when to stop: a `return` inside the `for await` breaks the
 * generator, which cancels the reader and the request. The signal is the only
 * interruption mechanism, so an unrelated UI change can stop a stream without
 * the caller having to know how the connection was opened.
 */
export async function* streamInference(
  origin: string,
  token: string,
  request: InferenceRequest,
  signal: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  let response: Response;
  try {
    response = await fetch(`${origin}/v1/inference`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: request.prompt }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw new InferenceError(`Cannot reach the agent: ${String(error)}`);
  }

  // A 401 here means the session died between the UI's check and this send, and
  // a 409 means the rental moved on underneath it. Either way the caller must
  // forget the token rather than retry with it. The generic branch below would
  // report both as an InferenceError, which the caller's session check does not
  // recognise, so the status has to be carried out of the stream path too.
  if (response.status === 401) throw new AgentError('Session is no longer valid', 401);
  if (response.status === 409) throw new AgentError('The rental changed; this session is no longer valid', 409);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new InferenceError(
      `Agent returned ${response.status} ${detail.slice(0, 200)}`.trim(),
    );
  }

  const body = response.body;
  if (!body) throw new InferenceError('Agent returned no response body.');
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    throw new InferenceError('Agent did not return the required SSE protocol.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const assembler = new InferenceAssembler();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const events = parser.push(chunk);
      for (const event of events) {
        yield assembler.apply(event);
        if (event.type === 'complete' || event.type === 'error') {
          // `complete` and `error` are terminal frames; the agent closes the
          // stream afterwards, so reading further only risks blocking.
          return;
        }
      }
    }

    // A stream closed without a blank line after the last frame still carries a
    // usable frame; the parser's `end()` flushes it rather than dropping it.
    for (const event of parser.end()) {
      yield assembler.apply(event);
      if (event.type === 'complete') return;
    }
    if (!signal.aborted) throw new InferenceError('Generation stream ended without a terminal complete event.');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  } finally {
    // Releasing the lock lets the browser close the connection promptly; without
    // it a cancelled fetch can leave the socket half-open.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function isSessionDead(error: unknown): boolean {
  return agentSessionDead(error) || (error instanceof InferenceError
    && ['ABORTED_AT_EXPIRY', 'RENTAL_EXPIRED', 'SESSION_EXPIRED'].includes(error.code ?? ''));
}
