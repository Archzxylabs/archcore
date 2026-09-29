import pino from 'pino';
import { REDACT_PATHS } from '@archcore/shared';

/**
 * Pino logger for the Provider Agent.
 *
 * Redaction follows PRD §36: the log may contain rentalId/requestId/timestamp/
 * latency/model/outcome but must never contain prompts, outputs, authorization
 * headers, cookies, session tokens, or wallet signatures.
 */
export function createLogger(
  config: {
    logLevel: string;
    host: string;
    port: number;
  },
  destination?: pino.DestinationStream,
): pino.Logger {
  const options = {
    level: config.logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
