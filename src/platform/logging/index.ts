import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Fields that must never reach a log sink. Redaction is applied by key name at every
 * depth so an accidentally spread object cannot leak key material or signed payloads.
 */
const REDACTED_PATHS = [
  'privateKey',
  'private_key',
  'signedTransaction',
  'signed_transaction',
  'signedRawTransaction',
  'rawTransaction',
  'secret',
  'jwt',
  'token',
  'authorization',
  'password',
].flatMap((field) => [field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`]);

export interface LogContext {
  requestId?: string;
  correlationId?: string;
  operationId?: string;
  transactionAttemptId?: string;
  transactionHash?: string;
  actorId?: string;
  [key: string]: unknown;
}

export function createLogger(options: { level: string; name: string }): Logger {
  return pino({
    name: options.name,
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    base: { service: options.name },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function childLogger(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}
