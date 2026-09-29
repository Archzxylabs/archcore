/**
 * Frozen P0 resource limits. These are enforced in the Provider Agent, not in
 * the UI — the UI only mirrors them.
 */
export interface ResourceLimits {
  /** Maximum accepted JSON request body, in bytes. */
  maxJsonBodyBytes: number;
  /** Maximum prompt length, in bytes. */
  maxPromptBytes: number;
  /** Maximum equivalent output tokens for the explicit demo backend. */
  maxOutputTokens: number;
  /** Maximum inference requests per rental. */
  maxRequestsPerRental: number;
  /** Maximum simultaneous generations for the whole agent. */
  maxConcurrentInference: number;
  /** Maximum wall clock time of one generation, in seconds. */
  maxGenerationSeconds: number;
  /** Minimum spacing between two inference requests of one rental, in seconds. */
  minRequestIntervalSeconds: number;
  /** EIP-712 challenge TTL, in seconds (exactly 60 per P0 spec). */
  challengeTtlSeconds: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  maxJsonBodyBytes: 16 * 1024,
  maxPromptBytes: 8 * 1024,
  maxOutputTokens: 256,
  maxRequestsPerRental: 10,
  maxConcurrentInference: 1,
  maxGenerationSeconds: 30,
  minRequestIntervalSeconds: 2,
  challengeTtlSeconds: 60,
};
