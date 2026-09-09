import type { Transaction } from '../../db/pool.js';
import type { EncodedCall, TransactionReceiptView } from '../../ports/evm-gateway.js';
import type { OperationRecord } from '../../db/repositories/operation-repository.js';
import type { AttemptPurpose } from '../../db/repositories/transaction-repository.js';
import type { ReconciliationReport } from '../transactions/reconciliation-service.js';
import type { Logger } from '../../platform/logging/index.js';

export interface PreparedChainWrite {
  readonly call: EncodedCall;
  /** Non-secret provenance recorded with the attempt and handed to the signer. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface SettledOperation {
  readonly operation: OperationRecord;
  readonly attemptId: string;
  readonly receipt: TransactionReceiptView;
}

/**
 * The type-specific half of executing an operation. The engine in operation-executor.ts
 * owns everything that must behave identically for every chain write: the worker lease,
 * the state machine, persist-before-broadcast and settlement.
 */
export interface OperationHandler {
  readonly purpose: AttemptPurpose;

  /**
   * Re-validates the operation against current state and returns the call to make. Runs
   * with no PostgreSQL transaction open, and must throw an AppError to refuse execution.
   */
  prepare(operation: OperationRecord, log: Logger): Promise<PreparedChainWrite>;

  /**
   * Re-checks, immediately before broadcast, that the operation may still execute. Runs
   * again for a signature that arrived late, when the world may have moved on since
   * `prepare`. Throws an AppError to withhold the signed transaction.
   */
  assertStillExecutable?(operation: OperationRecord): Promise<void>;

  /** Compares the receipt against expectations, persisting each check as an observation. */
  reconcile(settled: SettledOperation): Promise<ReconciliationReport>;

  /** Durable effect applied in the same transaction that marks the operation SUCCEEDED. */
  applySuccess?(tx: Transaction, settled: SettledOperation): Promise<void>;
}
