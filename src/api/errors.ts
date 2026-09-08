import { ZodError } from 'zod';
import type { AppError} from '../domain/errors.js';
import { ErrorCode, isAppError } from '../domain/errors.js';
import type { Logger } from '../platform/logging/index.js';

export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly requestId: string;
    readonly correlationId: string;
  };
}

export interface NormalizedError {
  readonly status: number;
  readonly body: ErrorResponseBody;
}

/**
 * Converts any thrown value into a stable JSON error response.
 *
 * Unrecognised errors collapse to a generic INTERNAL_ERROR: stack traces and driver
 * messages are logged, never returned, so internals cannot leak to a caller.
 */
export function normalizeError(
  error: unknown,
  context: { requestId: string; correlationId: string; logger: Logger },
): NormalizedError {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'request validation failed',
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
          requestId: context.requestId,
          correlationId: context.correlationId,
        },
      },
    };
  }

  if (isAppError(error)) {
    const appError: AppError = error;
    if (appError.httpStatus >= 500) {
      context.logger.error({ err: appError, code: appError.code }, 'request failed');
    } else {
      context.logger.warn({ code: appError.code, details: appError.details }, 'request rejected');
    }
    return {
      status: appError.httpStatus,
      body: {
        error: {
          code: appError.code,
          message: appError.message,
          ...(Object.keys(appError.details).length === 0 ? {} : { details: appError.details }),
          requestId: context.requestId,
          correlationId: context.correlationId,
        },
      },
    };
  }

  context.logger.error({ err: error }, 'unhandled error');
  return {
    status: 500,
    body: {
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'an internal error occurred',
        requestId: context.requestId,
        correlationId: context.correlationId,
      },
    },
  };
}
