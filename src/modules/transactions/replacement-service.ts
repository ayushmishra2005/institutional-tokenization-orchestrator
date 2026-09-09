import type { Database } from '../../db/pool.js';
import type { EvmGateway } from '../../ports/evm-gateway.js';
import type { SignerProvider } from '../../ports/signer-provider.js';
import type { ChainWriter, ChainWriteOutcome } from './chain-writer.js';
import type { OperationExecutor } from '../operations/operation-executor.js';
import { awaitConfirmation, type ConfirmationPolicy } from './confirmation.js';
import { bumpFees } from './transaction-intent.js';
import {
  AttemptStatus,
  findAttemptById,
  findLiveAttemptAtNonce,
  findStuckAttempts,
  readReservedNonce,
  recordObservation,
  recordReceipt,
  updateAttemptStatus,
  type TransactionAttemptRecord,
} from '../../db/repositories/transaction-repository.js';
import { findOperationById } from '../../db/repositories/operation-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { isTerminalOperationState, type OperationState } from '../../domain/operation-state.js';
import { systemActor } from '../../domain/roles.js';
import type { ChainProfile } from '../../platform/config/chain-profile.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';

export interface ReplacementSummary {
  readonly replaced: number;
  readonly recovered: number;
}

const STUCK_REASON = 'STUCK_NO_INCLUSION';
const RECOVERY_REASON = 'NONCE_LANE_RECOVERY';

/**
 * Keeps a signer lane moving.
 *
 * Two situations block it: a broadcast transaction that no longer gets mined at its fee,
 * and a reserved nonce whose transaction must never be broadcast at all. Both are cleared
 * by publishing something at that exact nonce - never by skipping it, because the chain
 * will not mine nonce n+1 until it has seen nonce n.
 */
export class TransactionReplacementService {
  private readonly actor = systemActor('replacement-sweep');

  constructor(
    private readonly deps: {
      db: Database;
      gateway: EvmGateway;
      signer: SignerProvider;
      chainWriter: ChainWriter;
      executor: OperationExecutor;
      profile: ChainProfile;
      confirmation: ConfirmationPolicy;
      metrics: Metrics;
      logger: Logger;
    },
  ) {}

  async sweep(): Promise<ReplacementSummary> {
    const replaced = await this.replaceStuckTransactions();
    const recovered = await this.recoverBlockedLane();
    return { replaced, recovered };
  }

  async replaceStuckTransactions(): Promise<number> {
    const { db, profile } = this.deps;
    const stuck = await findStuckAttempts(db, {
      chainId: profile.chainId,
      stuckAfterMs: profile.replacement.stuckAfterMs,
      maxReplacements: profile.replacement.maxReplacements,
      limit: 10,
    });

    let replaced = 0;
    for (const attempt of stuck) {
      if (await this.replaceOne(attempt)) replaced += 1;
    }
    return replaced;
  }

  private async replaceOne(attempt: TransactionAttemptRecord): Promise<boolean> {
    const { db, gateway, logger, metrics } = this.deps;
    if (attempt.transactionHash === null) return false;

    // Inclusion beats replacement: if the original was mined while the sweep was deciding,
    // replacing it would spend a fee to compete with a transaction that already won.
    const receipt = await gateway.getTransactionReceipt(attempt.transactionHash as `0x${string}`);
    if (receipt !== null) return false;

    if (attempt.operationId !== null) {
      const operation = await findOperationById(db, attempt.operationId);
      if (operation === null) return false;
      if (isTerminalOperationState(operation.state as OperationState)) return false;
    }

    const log = logger.child({
      transactionAttemptId: attempt.id,
      ...(attempt.operationId === null ? {} : { operationId: attempt.operationId }),
      nonce: attempt.nonce,
      chainId: attempt.chainId,
    });

    const fees = bumpFees(attempt, await gateway.getFeeEstimate(), this.replacementBump());
    let outcome: ChainWriteOutcome;
    try {
      outcome = await this.deps.chainWriter.replaceFees(
        attempt,
        { fees, reason: STUCK_REASON, correlationId: attempt.id },
        attempt.operationId === null
          ? {}
          : this.deps.executor.replacementHooks(attempt.operationId),
      );
    } catch (error) {
      metrics.transactionReplacements.inc({ purpose: attempt.purpose, result: 'error' });
      log.error({ err: error }, 'fee replacement refused');
      return false;
    }

    metrics.transactionReplacements.inc({ purpose: attempt.purpose, result: outcome.kind });
    await recordAuditEvent(db, {
      actor: this.actor,
      action: 'transaction.replaced',
      resourceType: 'transaction_attempt',
      resourceId: attempt.id,
      ...(attempt.operationId === null ? {} : { operationId: attempt.operationId }),
      correlationId: attempt.id,
      metadata: {
        replacementAttemptId: outcome.attemptId,
        replacementNumber: attempt.replacementNumber + 1,
        nonce: attempt.nonce,
        reason: STUCK_REASON,
        previousMaxFeePerGas: attempt.maxFeePerGas,
        maxFeePerGas: fees.maxFeePerGas.toString(),
        outcome: outcome.kind,
      },
    });

    log.warn(
      { replacementAttemptId: outcome.attemptId, outcome: outcome.kind },
      'replaced stuck transaction at the same nonce',
    );

    if (outcome.kind === 'SUBMITTED' && attempt.operationId !== null) {
      await this.deps.executor.observeAndFinalize({
        operationId: attempt.operationId,
        attemptId: outcome.attemptId,
        transactionHash: outcome.transactionHash as `0x${string}`,
        log,
      });
    }

    // The replacement now owns the nonce whatever the broadcast returned; an ambiguous
    // send is resolved by the recovery sweep, exactly as for a first attempt.
    return true;
  }

  /**
   * Clears a lane whose next nonce can never be consumed by the attempt holding it,
   * which is what a signed-but-withheld transaction leaves behind.
   */
  async recoverBlockedLane(): Promise<number> {
    const { db, gateway, profile, metrics } = this.deps;
    const signerAddress = await this.deps.signer.getSignerAddress();

    const reserved = await readReservedNonce(db, { chainId: profile.chainId, signerAddress });
    if (reserved === null) return 0;

    const chainNonce = await gateway.getTransactionCount(signerAddress, 'latest');
    if (chainNonce >= reserved) {
      metrics.nonceLanesBlocked.set(0);
      return 0;
    }

    const blocking = await findLiveAttemptAtNonce(db, {
      chainId: profile.chainId,
      signerAddress,
      nonce: chainNonce,
    });
    if (blocking === null) {
      metrics.nonceLanesBlocked.set(0);
      return 0;
    }

    // A recovery already exists for this nonce - most likely waiting on the signer, since
    // it has no operation to bring it back. Finish that one instead of issuing another.
    if (blocking.purpose === 'NONCE_RECOVERY') {
      metrics.nonceLanesBlocked.set(1);
      return (await this.resumeRecovery(blocking)) ? 1 : 0;
    }

    if (!isAbandoned(blocking)) {
      metrics.nonceLanesBlocked.set(0);
      return 0;
    }

    metrics.nonceLanesBlocked.set(1);
    return (await this.cancelNonce(blocking)) ? 1 : 0;
  }

  private async resumeRecovery(recovery: TransactionAttemptRecord): Promise<boolean> {
    if (recovery.status === AttemptStatus.FAILED) return false;

    const outcome =
      recovery.signedRawTransaction === null
        ? await this.deps.chainWriter.resumeSignature(recovery)
        : await this.deps.chainWriter.broadcast(
            recovery,
            recovery.signedRawTransaction,
            recovery.transactionHash!,
          );

    if (outcome.kind !== 'SUBMITTED') return false;
    await this.confirmRecovery(outcome.attemptId, outcome.transactionHash as `0x${string}`);
    this.deps.metrics.nonceLanesBlocked.set(0);
    return true;
  }

  private async cancelNonce(blocking: TransactionAttemptRecord): Promise<boolean> {
    const { db, gateway, metrics } = this.deps;
    const log = this.deps.logger.child({
      transactionAttemptId: blocking.id,
      nonce: blocking.nonce,
      chainId: blocking.chainId,
      recoveryAction: 'NONCE_CANCELLATION',
    });

    const fees = bumpFees(blocking, await gateway.getFeeEstimate(), this.replacementBump());
    let outcome: ChainWriteOutcome;
    try {
      outcome = await this.deps.chainWriter.cancelNonce(blocking, {
        fees,
        reason: RECOVERY_REASON,
        correlationId: blocking.id,
      });
    } catch (error) {
      metrics.nonceRecoveries.inc({ result: 'error' });
      log.error({ err: error }, 'nonce recovery refused');
      return false;
    }

    metrics.nonceRecoveries.inc({ result: outcome.kind });
    await recordAuditEvent(db, {
      actor: this.actor,
      action: 'transaction.nonce_recovered',
      resourceType: 'transaction_attempt',
      resourceId: blocking.id,
      ...(blocking.operationId === null ? {} : { operationId: blocking.operationId }),
      correlationId: blocking.id,
      metadata: {
        recoveryAttemptId: outcome.attemptId,
        nonce: blocking.nonce,
        blockedBy: blocking.status,
        outcome: outcome.kind,
      },
    });

    log.warn({ recoveryAttemptId: outcome.attemptId, outcome: outcome.kind }, 'issued nonce recovery');
    if (outcome.kind !== 'SUBMITTED') return false;

    await this.confirmRecovery(outcome.attemptId, outcome.transactionHash as `0x${string}`);
    metrics.nonceLanesBlocked.set(0);
    return true;
  }

  /**
   * A recovery transaction carries no business intent, so it is reconciled on its own
   * rather than through an operation handler: the only claim being made is that the chain
   * consumed the nonce.
   */
  private async confirmRecovery(attemptId: string, hash: `0x${string}`): Promise<void> {
    const confirmation = await awaitConfirmation(this.deps.gateway, hash, this.deps.confirmation);
    if (confirmation.kind === 'PENDING' || confirmation.kind === 'ORPHANED') return;

    const receipt = confirmation.receipt;
    const attempt = await findAttemptById(this.deps.db, attemptId);
    if (attempt === null) return;

    await this.deps.db.transaction(async (tx) => {
      await recordReceipt(tx, {
        attemptId,
        status: receipt.status === 'success' ? AttemptStatus.INCLUDED : AttemptStatus.REVERTED,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: Number(receipt.gasUsed),
        receiptStatus: receipt.status === 'success' ? 1 : 0,
        contractAddress: receipt.contractAddress,
      });
      await recordObservation(tx, {
        operationId: null,
        transactionAttemptId: attemptId,
        kind: 'RECEIPT',
        chainId: attempt.chainId,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        matched: receipt.status === 'success',
        severity: receipt.status === 'success' ? 'INFO' : 'WARNING',
        expected: { status: 'success', nonce: attempt.nonce },
        actual: { status: receipt.status, blockNumber: receipt.blockNumber },
        detail: receipt.status === 'success' ? null : 'nonce recovery transaction reverted',
      });
      if (confirmation.kind === 'FINALIZED' && receipt.status === 'success') {
        await updateAttemptStatus(tx, { attemptId, status: AttemptStatus.CONFIRMED });
      }
    });
  }

  private replacementBump(): number {
    return this.deps.profile.replacement.feeBumpPercent;
  }
}

/**
 * The attempt at this nonce will never be mined: it either failed before broadcast or was
 * signed and then withheld. Anything still in flight is left alone - it may yet land, and
 * cancelling it could race a transaction that carries real value.
 */
function isAbandoned(attempt: TransactionAttemptRecord): boolean {
  return attempt.status === AttemptStatus.FAILED && attempt.blockNumber === null;
}
