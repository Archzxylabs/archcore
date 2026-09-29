/**
 * Log redaction helpers.
 *
 * P0 rule (PRD §36): may log rentalId, requestId, timestamp, latency, model,
 * success/failure. Must never log prompt, messages, generated answer,
 * authorization, cookie, session token, wallet signature, or any private user
 * content. Fastify request-body logging stays OFF on top of this.
 */

/** Pino `redact` paths used by the Agent logger. */
export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'signature',
  'nonce',
  'challengeNonce',
  'sessionToken',
  'session_token',
  'token',
  'prompt',
  'messages',
  'output',
  'choices',
  'response',
  'password',
  'privateKey',
  'private_key',
  'dbPath',
  'settlementDbPath',
  'db_path',
  'settlement_db_path',
  'rawTransaction',
  'raw_transaction',
  'signedTransaction',
  'signed_transaction',
  'providerPrivateKey',
  'provider_private_key',
  'rpcUrl',
  'rpc_url',
];

/** Field names whose values must never reach a log line, recursively. */
export const SENSITIVE_KEYS = new Set<string>([
  'prompt',
  'messages',
  'content',
  'output',
  'signature',
  'signedmessage',
  'signaturev4',
  'signaturehex',
  'nonce',
  'challengenonce',
  'authorization',
  'cookie',
  'bearer',
  'token',
  'sessiontoken',
  'session_token',
  'session',
  'rawtoken',
  'privatekey',
  'providerprivatekey',
  'provider_private_key',
  'rpcurl',
  'rpc_url',
  'mnemonic',
  'seed',
  'choices',
  'response',
  'typeddata',
  'message',
  'dbpath',
  'settlementdbpath',
  'rawtransaction',
  'signedtransaction',
]);

/**
 * Deep-clone a value with sensitive keys replaced by a placeholder. Used for
 * structured log payloads built outside the Fastify request logger.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return '[TRUNCATED]' as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? '[REDACTED]'
        : redactDeep(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
