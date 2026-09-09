import { canonicalHash } from '../../domain/canonical.js';
import { AppError, ErrorCode } from '../../domain/errors.js';
import type { FeeEstimate } from '../../ports/evm-gateway.js';
import type { TransactionAttemptRecord } from '../../db/repositories/transaction-repository.js';

export interface TransactionIntent {
  readonly chainId: number;
  readonly from: string;
  readonly to: string | null;
  readonly data: string;
  readonly value: string;
  readonly purpose: string;
  readonly operationId: string | null;
}

/**
 * Identifies what a transaction is authorised to do, deliberately excluding nonce, gas
 * limit and fees. Two attempts sharing a fingerprint carry the same financial intent, so
 * a fee replacement can reuse the original business approval; anything else may not.
 */
export function intentFingerprint(intent: TransactionIntent): string {
  return canonicalHash({
    chainId: intent.chainId,
    from: intent.from.toLowerCase(),
    to: intent.to === null ? null : intent.to.toLowerCase(),
    data: intent.data.toLowerCase(),
    value: intent.value,
    purpose: intent.purpose,
    operationId: intent.operationId,
  });
}

export function fingerprintOf(attempt: TransactionAttemptRecord): string {
  return intentFingerprint({
    chainId: attempt.chainId,
    from: attempt.fromAddress,
    to: attempt.toAddress,
    data: attempt.data,
    value: attempt.value,
    purpose: attempt.purpose,
    operationId: attempt.operationId,
  });
}

/**
 * Fee-only replacement is the single case where a previously approved operation may be
 * signed again. Every field the approval covered is compared, and the recorded
 * fingerprint is recomputed from the row so a tampered column cannot pass unnoticed.
 */
export function assertFeeOnlyReplacement(
  previous: TransactionAttemptRecord,
  replacement: {
    chainId: number;
    fromAddress: string;
    toAddress: string | null;
    data: string;
    value: string;
    nonce: number;
    purpose: string;
    operationId: string | null;
  },
): void {
  const mismatch = (field: string, expected: unknown, actual: unknown): never => {
    throw new AppError(
      ErrorCode.REPLACEMENT_INTENT_MISMATCH,
      `replacement changes ${field}; only fee fields may differ`,
      { details: { field, expected, actual, previousAttemptId: previous.id } },
    );
  };

  if (replacement.nonce !== previous.nonce) {
    mismatch('nonce', previous.nonce, replacement.nonce);
  }
  if (replacement.chainId !== previous.chainId) {
    mismatch('chainId', previous.chainId, replacement.chainId);
  }
  if (replacement.fromAddress.toLowerCase() !== previous.fromAddress.toLowerCase()) {
    mismatch('signer', previous.fromAddress, replacement.fromAddress);
  }
  if ((replacement.toAddress?.toLowerCase() ?? null) !== previous.toAddress) {
    mismatch('destination', previous.toAddress, replacement.toAddress);
  }
  if (replacement.data.toLowerCase() !== previous.data) {
    mismatch('calldata', previous.data, replacement.data);
  }
  if (replacement.value !== previous.value) {
    mismatch('value', previous.value, replacement.value);
  }
  if (replacement.purpose !== previous.purpose) {
    mismatch('purpose', previous.purpose, replacement.purpose);
  }
  if (replacement.operationId !== previous.operationId) {
    mismatch('operation', previous.operationId, replacement.operationId);
  }

  const expected = fingerprintOf(previous);
  const actual = intentFingerprint({
    chainId: replacement.chainId,
    from: replacement.fromAddress,
    to: replacement.toAddress,
    data: replacement.data,
    value: replacement.value,
    purpose: replacement.purpose,
    operationId: replacement.operationId,
  });
  if (actual !== expected || (previous.intentFingerprint ?? expected) !== expected) {
    mismatch('intentFingerprint', expected, actual);
  }
}

/**
 * A node only accepts a same-nonce transaction if both fee fields rise, so the bump is
 * applied to the previous attempt's own fees and never merely to the current estimate.
 */
export function bumpFees(
  previous: { maxFeePerGas: string; maxPriorityFeePerGas: string },
  current: FeeEstimate,
  bumpPercent: number,
): FeeEstimate {
  const scale = (value: bigint): bigint => (value * BigInt(100 + bumpPercent)) / 100n + 1n;
  return {
    maxFeePerGas: max(scale(BigInt(previous.maxFeePerGas)), current.maxFeePerGas),
    maxPriorityFeePerGas: max(
      scale(BigInt(previous.maxPriorityFeePerGas)),
      current.maxPriorityFeePerGas,
    ),
  };
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
