import { ResourceLimits, ArchcoreError, DEFAULT_LIMITS, type ErrorCodeValue } from '@archcore/shared';
import {
  type InferenceBackendAdapter,
  BackendError,
} from './adapter.js';

/**
 * Fan-ins a caller-owned signal and a hard timeout into one derived signal.
 *
 * The timeout aborts the request rather than losing a promise race: aborting
 * cancels the underlying transport request, so no socket is left open. `dispose()`
 * clears the timer and detaches the listener, and must run in a `finally`.
 */
export function linkAbortSignal(
  external: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const forward = (): void => abort(external.reason);

  const timer = setTimeout(
    () => abort(new InferenceError('generation exceeded max duration', 'ABORTED_AT_EXPIRY', 408)),
    timeoutMs,
  );
  timer.unref?.();

  if (external.aborted) {
    forward();
  } else {
    external.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external.removeEventListener('abort', forward);
    },
  };
}

/** Prompt-level guard that lives on the inference call boundary. */
export interface InferenceOptions {
  model: string;
  prompt: string;
  options?: { num_predict?: number };
}

/** Canonical response shape for `/v1/inference`. */
export interface InferenceResult {
  output: string;
  model: string;
  latencyMs: number;
  /** Token usage reported by the backend, if any. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Streaming callbacks fired while backend chunks arrive. The route
 * forwards each delta to the client, so a terminated lease stops tokens
 * flowing instead of buffering the whole answer.
 */
export interface InferenceStreamHandlers {
  onDelta?: (delta: string, cumulative: string) => void;
  onComplete?: (result: InferenceResult) => void;
}

export class InferenceError extends ArchcoreError {
  constructor(message: string, code: ErrorCodeValue, statusCode: number = 500) {
    super(code, message, statusCode);
    this.name = 'InferenceError';
  }
}

export class InferenceClient {
  constructor(
    private readonly backend: InferenceBackendAdapter,
    private readonly limits: ResourceLimits = DEFAULT_LIMITS,
  ) {}

  get model(): string {
    return this.backend.model;
  }

  /**
   * Enforces every P0 resource guard before issuing the backend call.
   *
   * `signal` is owned by the caller (the route handler) and fires when the
   * lease has been revoked — either by the reservation watcher or by the
   * renter cancelling on-chain or timing out.
   */
  async generate(params: InferenceOptions, signal: AbortSignal): Promise<InferenceResult> {
    const started = Date.now();

    // Body size guard.
    this.assertSize(params.prompt, this.limits.maxPromptBytes);

    // Token budget guard.
    const tokenBudget = this.limits.maxOutputTokens;
    const numPredict = params.options?.num_predict;
    if (numPredict !== undefined && numPredict > tokenBudget) {
      throw new InferenceError(
        `num_predict ${numPredict} exceeds the per-request token budget ${tokenBudget}`,
        'RATE_LIMITED',
        413,
      );
    }

    if (params.model !== this.backend.model) {
      throw new InferenceError(
        `model ${params.model} is not the configured model`,
        'MODEL_NOT_ALLOWED',
        403,
      );
    }

    const gate = linkAbortSignal(signal, this.limits.maxGenerationSeconds * 1000);

    try {
      const result = await this.backend.generate({
        model: params.model,
        prompt: params.prompt,
        maxTokens: numPredict !== undefined ? numPredict : this.limits.maxOutputTokens,
        signal: gate.signal,
      });
      return {
        output: result.text,
        model: this.backend.model,
        latencyMs: Date.now() - started,
        usage: {
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
        },
      };
    } catch (error) {
      throw this.toInferenceError(error);
    } finally {
      gate.dispose();
    }
  }

  /**
   * Streamed variant of {@link generate}, enforcing the exact same guards.
   *
   * The caller owns the `AbortController` and forwards its signal here, so the
   * lease-expiry timer, the generation watchdog and the client-disconnect hook
   * all cancel one and the same in-flight backend request.
   */
  async generateStream(
    params: InferenceOptions,
    signal: AbortSignal,
    handlers: InferenceStreamHandlers = {},
  ): Promise<InferenceResult> {
    const started = Date.now();

    this.assertSize(params.prompt, this.limits.maxPromptBytes);
    const numPredict = this.clampTokenBudget(params.options?.num_predict);

    if (params.model !== this.backend.model) {
      throw new InferenceError(
        `model ${params.model} is not the configured model`,
        'MODEL_NOT_ALLOWED',
        403,
      );
    }

    let cumulative = '';
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    const gate = linkAbortSignal(signal, this.limits.maxGenerationSeconds * 1000);
    try {
      let complete = false;
      for await (const chunk of this.backend.generateStream({
        model: params.model,
        prompt: params.prompt,
        maxTokens: numPredict,
        signal: gate.signal,
      })) {
        if (gate.signal.aborted) throw new InferenceError('generation stopped', 'ABORTED_AT_EXPIRY');
        if (typeof chunk.error === 'string' && chunk.error.length > 0) {
          throw new InferenceError(chunk.error, 'INFERENCE_FAILED', 500);
        }
        if (typeof chunk.delta === 'string') {
          cumulative += chunk.delta;
          if (chunk.delta.length > 0) {
            handlers.onDelta?.(chunk.delta, cumulative);
          }
        }
        if (typeof chunk.promptTokens === 'number') promptTokens = chunk.promptTokens;
        if (typeof chunk.completionTokens === 'number') completionTokens = chunk.completionTokens;
        if (chunk.done) { complete = true; break; }
      }
      if (gate.signal.aborted) throw new InferenceError('generation stopped', 'ABORTED_AT_EXPIRY');
      if (!complete) throw new InferenceError('backend stream ended without completion', 'INFERENCE_FAILED');
    } catch (error) {
      throw this.toInferenceError(error);
    } finally {
      gate.dispose();
    }

    const result: InferenceResult = {
      output: cumulative,
      model: this.backend.model,
      latencyMs: Date.now() - started,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    };
    handlers.onComplete?.(result);
    return result;
  }

  /**
   * Output is capped, never negotiated: a request may ask for fewer tokens but
   * never more than the frozen P0 budget, and anything unspecified pins to it.
   */
  private clampTokenBudget(requested: number | undefined): number {
    const budget = this.limits.maxOutputTokens;
    if (requested === undefined) return budget;
    if (requested > budget) {
      throw new InferenceError(
        `num_predict ${requested} exceeds the per-request token budget ${budget}`,
        'RATE_LIMITED',
        413,
      );
    }
    return requested;
  }

  private toInferenceError(error: unknown): ArchcoreError {
    if (error instanceof BackendError) {
      const codeMap: Record<string, ErrorCodeValue> = {
        ABORTED_AT_EXPIRY: 'ABORTED_AT_EXPIRY',
        INFERENCE_FAILED: 'INFERENCE_FAILED',
        MODEL_NOT_ALLOWED: 'MODEL_NOT_ALLOWED',
        BACKEND_BLOCKED: 'DEPENDENCY_UNAVAILABLE',
      };
      const statusMap: Record<string, number> = {
        ABORTED_AT_EXPIRY: 408,
        MODEL_NOT_ALLOWED: 403,
        BACKEND_BLOCKED: 503,
      };
      return new InferenceError(
        error.message,
        codeMap[error.code] ?? 'INFERENCE_FAILED',
        statusMap[error.code] ?? 500,
      );
    }
    if (error instanceof ArchcoreError) return error;
    return new InferenceError(
      error instanceof Error ? error.message : 'inference failed',
      'INFERENCE_FAILED',
      500,
    );
  }

  private assertSize(prompt: string, maxBytes: number): void {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > maxBytes) {
      throw new InferenceError(
        `prompt is ${bytes} bytes, limit is ${maxBytes} bytes`,
        'BODY_TOO_LARGE',
        413,
      );
    }
  }
}
