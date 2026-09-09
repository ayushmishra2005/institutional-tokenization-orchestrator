/**
 * Stable, machine-readable error codes. These are part of the HTTP contract:
 * clients branch on `error.code`, never on the human-readable message.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  APPROVAL_ALREADY_RECORDED: 'APPROVAL_ALREADY_RECORDED',
  SELF_APPROVAL_NOT_ALLOWED: 'SELF_APPROVAL_NOT_ALLOWED',
  APPROVAL_REQUEST_CLOSED: 'APPROVAL_REQUEST_CLOSED',
  COMPLIANCE_NOT_ELIGIBLE: 'COMPLIANCE_NOT_ELIGIBLE',
  ASSET_PAUSED: 'ASSET_PAUSED',
  ASSET_NOT_ACTIVE: 'ASSET_NOT_ACTIVE',
  SUPPLY_CAP_EXCEEDED: 'SUPPLY_CAP_EXCEEDED',
  OPERATION_CONFLICT: 'OPERATION_CONFLICT',
  CHAIN_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
  CHAIN_IDENTITY_MISMATCH: 'CHAIN_IDENTITY_MISMATCH',
  SIGNER_REJECTED: 'SIGNER_REJECTED',
  SIGNED_TRANSACTION_MISMATCH: 'SIGNED_TRANSACTION_MISMATCH',
  NONCE_DIVERGENCE: 'NONCE_DIVERGENCE',
  REPLACEMENT_INTENT_MISMATCH: 'REPLACEMENT_INTENT_MISMATCH',
  REPLACEMENT_LIMIT_REACHED: 'REPLACEMENT_LIMIT_REACHED',
  SIMULATION_FAILED: 'SIMULATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  INVALID_STATE_TRANSITION: 409,
  APPROVAL_ALREADY_RECORDED: 409,
  SELF_APPROVAL_NOT_ALLOWED: 409,
  APPROVAL_REQUEST_CLOSED: 409,
  COMPLIANCE_NOT_ELIGIBLE: 422,
  ASSET_PAUSED: 409,
  ASSET_NOT_ACTIVE: 409,
  SUPPLY_CAP_EXCEEDED: 422,
  OPERATION_CONFLICT: 409,
  CHAIN_UNAVAILABLE: 503,
  CHAIN_IDENTITY_MISMATCH: 500,
  SIGNER_REJECTED: 502,
  SIGNED_TRANSACTION_MISMATCH: 500,
  NONCE_DIVERGENCE: 500,
  REPLACEMENT_INTENT_MISMATCH: 500,
  REPLACEMENT_LIMIT_REACHED: 409,
  SIMULATION_FAILED: 422,
  INTERNAL_ERROR: 500,
};

export type ErrorDetails = Record<string, unknown>;

/** Base class for every error the application deliberately surfaces to a caller. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: ErrorDetails;
  /** True when the same input could succeed later (transient infrastructure faults). */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: ErrorDetails; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.VALIDATION_ERROR, message, details === undefined ? {} : { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'authentication required') {
    super(ErrorCode.UNAUTHORIZED, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.FORBIDDEN, message, details === undefined ? {} : { details });
  }
}

export class NotFoundError extends AppError {
  constructor(resourceType: string, resourceId: string) {
    super(ErrorCode.RESOURCE_NOT_FOUND, `${resourceType} not found`, {
      details: { resourceType, resourceId },
    });
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(machine: string, from: string, to: string) {
    super(ErrorCode.INVALID_STATE_TRANSITION, `invalid ${machine} transition ${from} -> ${to}`, {
      details: { machine, from, to },
    });
  }
}

export class ChainUnavailableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.CHAIN_UNAVAILABLE, message, { retryable: true, cause });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
