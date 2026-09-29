import { setTimeout as pause } from 'node:timers/promises';

/**
 * Smallest typed provider contract for ARCHcore Provider Agent inference adapter.
 *
 * PRD v0.5: the Agent owns the explicit simulated demo backend. The browser
 * never contacts a backend directly. Private ingress is separate/deferred.
 * The fixed model is not selectable by renters.
 * - Supports streaming deltas, terminal result/errors, cancellation/abort propagation,
 *   and health/readiness checks.
 */

export interface BackendGenerateRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
}

export interface BackendStreamChunk {
  /** Text delta generated in this chunk. */
  delta?: string;
  /** Set to true on the final chunk. */
  done?: boolean;
  /** Error message if generation failed mid-stream. */
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface BackendGenerateResult {
  model: string;
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface BackendReadiness {
  ok: boolean;
  detail: string;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: string = 'INFERENCE_FAILED',
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Typed provider contract implemented by all backend adapters (production and test doubles).
 */
export interface InferenceBackendAdapter {
  /** The fixed model configured by the operator */
  readonly model: string;

  /** Health and readiness probe for the backend */
  checkReadiness(): Promise<BackendReadiness>;

  /** Non-streaming generation */
  generate(request: BackendGenerateRequest): Promise<BackendGenerateResult>;

  /** Streaming generation yielding chunks with deltas, done, or error */
  generateStream(
    request: BackendGenerateRequest,
  ): AsyncGenerator<BackendStreamChunk, void, unknown>;
}

/**
 * Fail-closed adapter for an explicitly unsupported or unavailable backend.
 * P0's runnable demo backend is selected explicitly, never as a fallback.
 */
export class BlockedInferenceBackendAdapter implements InferenceBackendAdapter {
  readonly model: string;
  readonly reason: string;

  constructor(reason = 'An explicitly supported inference backend is not configured') {
    this.model = 'BLOCKED_NO_OPERATOR_CONFIG';
    this.reason = reason;
  }

  async checkReadiness(): Promise<BackendReadiness> {
    return {
      ok: false,
      detail: `BLOCKED: ${this.reason}`,
    };
  }

  async generate(): Promise<BackendGenerateResult> {
    throw new BackendError(`Inference backend is BLOCKED: ${this.reason}`, 'BACKEND_BLOCKED');
  }

  // eslint-disable-next-line require-yield
  async *generateStream(): AsyncGenerator<BackendStreamChunk, void, unknown> {
    throw new BackendError(`Inference backend is BLOCKED: ${this.reason}`, 'BACKEND_BLOCKED');
  }
}

/**
 * P0 Demo Inference Backend.
 *
 * Implements the explicit simulated Demo Inference Backend for ARCHcore P0 (v0.5 PRD §1, §3.1).
 * Identifies as model `archcore-demo-simulated`, produces bounded simulated text output
 * (up to 256 tokens), supports AbortSignal cancellation and timeout.
 */
export class DemoInferenceBackend implements InferenceBackendAdapter {
  readonly model = 'archcore-demo-simulated';

  async checkReadiness(): Promise<BackendReadiness> {
    return {
      ok: true,
      detail: 'Demo inference backend ready (simulated)',
    };
  }

  async generate(request: BackendGenerateRequest): Promise<BackendGenerateResult> {
    let text = '';
    for await (const chunk of this.generateStream(request)) text += chunk.delta ?? '';
    return { model: this.model, text };
  }

  async *generateStream(
    request: BackendGenerateRequest,
  ): AsyncGenerator<BackendStreamChunk, void, unknown> {
    if (request.signal.aborted) {
      throw new BackendError('generation aborted', 'ABORTED');
    }

    if (request.model !== this.model) throw new BackendError('model not allowed', 'MODEL_NOT_ALLOWED');
    const text = `Demo response: ${request.prompt.slice(0, 160)}\n\nThis is simulated text generation through the ARCHcore Provider Agent. Your wallet, USDG escrow, rental access checks and authentication are real; no physical GPU or live AI model is used.`;
    const chunks = (text.match(/\S+\s*/g) ?? []).slice(0, Math.min(256, Math.max(1, request.maxTokens)));
    for (let i = 0; i < chunks.length; i++) {
      if (request.signal.aborted) {
        throw new BackendError('generation aborted', 'ABORTED');
      }
      await pause(35, undefined, { signal: request.signal });
      const isLast = i === chunks.length - 1;
      yield {
        delta: chunks[i],
        done: isLast,
      };
    }
  }
}

/**
 * Labeled unit-test fake adapter.
 *
 * Explicitly labeled as a unit test fake: does not represent live hardware,
 * OmniRoute connectivity, or live GPU inference.
 */
export class UnitTestInferenceBackendFake implements InferenceBackendAdapter {
  public isReady = true;
  public readinessDetail = 'UnitTestInferenceBackendFake ready';
  public streamChunks: string[] = ['Hello', ' from', ' fake', ' backend!'];
  public latencyMs = 10;
  public errorToThrow: Error | null = null;
  public chunkError: string | null = null;
  public delayMs = 0;
  public calls: BackendGenerateRequest[] = [];

  constructor(public readonly model = 'test-model') {}

  async checkReadiness(): Promise<BackendReadiness> {
    return {
      ok: this.isReady,
      detail: this.readinessDetail,
    };
  }

  async generate(request: BackendGenerateRequest): Promise<BackendGenerateResult> {
    this.calls.push(request);
    if (this.errorToThrow) throw this.errorToThrow;
    if (request.model !== this.model) {
      throw new BackendError(`model ${request.model} is not the configured model`, 'MODEL_NOT_ALLOWED');
    }
    if (request.signal.aborted) {
      throw new BackendError('generation aborted at lease expiry', 'ABORTED_AT_EXPIRY');
    }
    return {
      model: this.model,
      text: this.streamChunks.join(''),
      promptTokens: 5,
      completionTokens: 10,
    };
  }

  async *generateStream(
    request: BackendGenerateRequest,
  ): AsyncGenerator<BackendStreamChunk, void, unknown> {
    this.calls.push(request);
    if (this.errorToThrow) throw this.errorToThrow;
    if (request.model !== this.model) {
      throw new BackendError(`model ${request.model} is not the configured model`, 'MODEL_NOT_ALLOWED');
    }

    const abortPromise = new Promise<never>((_, reject) => {
      if (request.signal.aborted) {
        reject(new BackendError('generation aborted at lease expiry', 'ABORTED_AT_EXPIRY'));
      }
      request.signal.addEventListener(
        'abort',
        () => reject(new BackendError('generation aborted at lease expiry', 'ABORTED_AT_EXPIRY')),
        { once: true },
      );
    });

    for (let i = 0; i < this.streamChunks.length; i++) {
      if (request.signal.aborted) {
        throw new BackendError('generation aborted at lease expiry', 'ABORTED_AT_EXPIRY');
      }
      if (this.delayMs > 0) {
        await Promise.race([
          new Promise((r) => setTimeout(r, this.delayMs)),
          abortPromise,
        ]);
      }
      if (this.chunkError && i === Math.floor(this.streamChunks.length / 2)) {
        throw new BackendError(this.chunkError, 'INFERENCE_FAILED');
      }
      const isLast = i === this.streamChunks.length - 1;
      yield {
        delta: this.streamChunks[i],
        done: isLast,
        promptTokens: isLast ? 5 : undefined,
        completionTokens: isLast ? 10 : undefined,
      };
    }
  }
}
