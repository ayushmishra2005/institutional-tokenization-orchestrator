import type { Database, Transaction } from '../../db/pool.js';
import type { EvmGateway, EncodedCall } from '../../ports/evm-gateway.js';
import type {
  SignerProvider,
  SignerRequestState,
  UnsignedTransactionRequest,
} from '../../ports/signer-provider.js';
import { verifySignedTransaction } from '../../adapters/evm/signed-transaction-verifier.js';
import {
  AttemptStatus,
  insertPreparedAttempt,
  persistSignedAttempt,
  reserveNonce,
  updateAttemptStatus,
  type AttemptPurpose,
  type TransactionAttemptRecord,
} from '../../db/repositories/transaction-repository.js';
import {
  findSignerRequestForAttempt,
  markSignerRequestRefused,
  markSignerRequestSigned,
  recordSignerRequest,
  touchSignerRequest,
} from '../../db/repositories/signer-request-repository.js';
import { AppError, ErrorCode, isAppError } from '../../domain/errors.js';
import { canonicalHash } from '../../domain/canonical.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';

/** Multiplier applied to the simulated gas estimate to absorb small state drift. */
const GAS_BUFFER_NUMERATOR = 5n;
const GAS_BUFFER_DENOMINATOR = 4n;

export interface ChainWriteHooks {
  /** Runs in the transaction that reserves the nonce and records the attempt. */
  onPrepared?(tx: Transaction, attempt: TransactionAttemptRecord): Promise<void>;
  /** Runs in the transaction that durably stores the signed bytes. */
  onSigned?(tx: Transaction, attempt: TransactionAttemptRecord): Promise<void>;
  /**
   * Last chance to stop a signed transaction that must no longer happen. Throwing here
   * keeps the signed bytes as evidence and leaves the chain untouched.
   */
  assertBroadcastAllowed?(): Promise<void>;
  onBroadcasting?(tx: Transaction, attempt: TransactionAttemptRecord): Promise<void>;
  onSubmitted?(tx: Transaction, attempt: TransactionAttemptRecord, hash: string): Promise<void>;
  onBroadcastUnknown?(
    tx: Transaction,
    attempt: TransactionAttemptRecord,
    reason: string,
  ): Promise<void>;
  onFailed?(
    tx: Transaction,
    attempt: TransactionAttemptRecord,
    failure: { code: string; message: string },
  ): Promise<void>;
}

export interface ChainWriteIntent {
  readonly purpose: AttemptPurpose;
  readonly call: EncodedCall;
  readonly operationId: string | null;
  readonly assetId: string | null;
  readonly walletId: string | null;
  readonly correlationId: string;
  /** Non-secret context handed to the signer for policy evaluation and audit. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export type ChainWriteOutcome =
  | { readonly kind: 'SUBMITTED'; readonly attemptId: string; readonly transactionHash: string }
  | {
      /** The signer has the request but has not decided; nothing has been broadcast. */
      readonly kind: 'SIGNATURE_PENDING';
      readonly attemptId: string;
      readonly providerRequestId: string;
    }
  | {
      readonly kind: 'BROADCAST_UNKNOWN';
      readonly attemptId: string;
      readonly transactionHash: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'FAILED';
      readonly attemptId: string;
      readonly code: string;
      readonly message: string;
    };

export interface ChainWriterDeps {
  readonly db: Database;
  readonly gateway: EvmGateway;
  readonly signer: SignerProvider;
  readonly chainId: number;
  readonly signerRequestTimeoutMs: number;
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/**
 * Executes a single allowlisted chain write with persist-before-broadcast semantics.
 *
 * Every RPC call, signer call and broadcast runs with no PostgreSQL transaction open, and
 * each durable step commits on its own, so a crash at any point leaves an unambiguous record.
 */
export class ChainWriter {
  constructor(private readonly deps: ChainWriterDeps) {}

  async execute(intent: ChainWriteIntent, hooks: ChainWriteHooks = {}): Promise<ChainWriteOutcome> {
    const { db, gateway, signer, logger } = this.deps;
    const signerAddress = await signer.getSignerAddress();

    await gateway.getChainIdentity();

    const simulation = await gateway.simulate({
      from: signerAddress,
      to: intent.call.to,
      data: intent.call.data,
      value: 0n,
    });
    if (!simulation.ok) {
      throw new AppError(ErrorCode.SIMULATION_FAILED, 'transaction simulation reverted', {
        details: { revertReason: simulation.revertReason, purpose: intent.purpose },
      });
    }

    const fees = await gateway.getFeeEstimate();
    const chainNonce = await gateway.getTransactionCount(signerAddress, 'latest');
    const gasLimit = (simulation.gasEstimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;

    const attempt = await db.transaction(async (tx) => {
      const nonce = await reserveNonce(tx, {
        chainId: this.deps.chainId,
        signerAddress,
        chainNonce,
      });

      const requestHash = canonicalHash({
        chainId: this.deps.chainId,
        from: signerAddress.toLowerCase(),
        to: intent.call.to === null ? null : intent.call.to.toLowerCase(),
        nonce,
        value: '0',
        data: intent.call.data.toLowerCase(),
        gasLimit: gasLimit.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      });

      const prepared = await insertPreparedAttempt(tx, {
        operationId: intent.operationId,
        assetId: intent.assetId,
        walletId: intent.walletId,
        purpose: intent.purpose,
        chainId: this.deps.chainId,
        fromAddress: signerAddress,
        toAddress: intent.call.to,
        nonce,
        data: intent.call.data,
        gasLimit: Number(gasLimit),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        requestHash,
      });

      await hooks.onPrepared?.(tx, prepared);
      return prepared;
    });

    const request: UnsignedTransactionRequest = {
      attemptId: attempt.id,
      chainId: this.deps.chainId,
      from: signerAddress,
      to: intent.call.to,
      nonce: attempt.nonce,
      value: 0n,
      data: intent.call.data as `0x${string}`,
      gasLimit: BigInt(attempt.gasLimit),
      maxFeePerGas: BigInt(attempt.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(attempt.maxPriorityFeePerGas),
    };

    const state = await signer.requestSignature(request, {
      purpose: intent.purpose,
      ...(intent.operationId === null ? {} : { operationId: intent.operationId }),
      ...(intent.assetId === null ? {} : { assetId: intent.assetId }),
      correlationId: intent.correlationId,
      evidence: intent.evidence,
    });

    const signerRequest = await recordSignerRequest(db, {
      transactionAttemptId: attempt.id,
      operationId: intent.operationId,
      provider: signer.name,
      providerRequestId: state.providerRequestId,
      status: state.status,
      requestFingerprint: attempt.requestHash,
    });
    this.deps.metrics.signerRequests.inc({ provider: signer.name, outcome: state.status });

    if (state.status === 'PENDING') {
      logger.info(
        { transactionAttemptId: attempt.id, providerRequestId: state.providerRequestId },
        'signature request pending with the signer',
      );
      return {
        kind: 'SIGNATURE_PENDING',
        attemptId: attempt.id,
        providerRequestId: state.providerRequestId,
      };
    }

    return this.settleSignature(attempt, request, state, signerRequest.id, hooks);
  }

  /**
   * Resumes an attempt whose signature was still outstanding, using the provider request
   * the previous worker created. Never submits a new request: the provider may already be
   * holding an authorised signature for these exact bytes.
   */
  async resumeSignature(
    attempt: TransactionAttemptRecord,
    hooks: ChainWriteHooks = {},
  ): Promise<ChainWriteOutcome> {
    const { db, signer } = this.deps;
    const signerRequest = await findSignerRequestForAttempt(db, attempt.id);
    if (signerRequest === null || signerRequest.status !== 'PENDING') {
      return {
        kind: 'FAILED',
        attemptId: attempt.id,
        code: ErrorCode.SIGNER_REJECTED,
        message: 'no outstanding signature request for this attempt',
      };
    }

    const state = await signer.fetchSignature(signerRequest.providerRequestId);
    await touchSignerRequest(db, signerRequest.id);

    if (state.status === 'PENDING') {
      const waitedMs = Date.now() - signerRequest.requestedAt.getTime();
      if (waitedMs < this.deps.signerRequestTimeoutMs) {
        return {
          kind: 'SIGNATURE_PENDING',
          attemptId: attempt.id,
          providerRequestId: signerRequest.providerRequestId,
        };
      }

      await markSignerRequestRefused(db, {
        id: signerRequest.id,
        status: 'EXPIRED',
        rejectionCode: 'SIGNER_REQUEST_TIMEOUT',
      });
      this.deps.metrics.signerFailures.inc({ reason: 'SIGNER_REQUEST_TIMEOUT' });
      await this.failAttempt(attempt, hooks, {
        code: ErrorCode.SIGNER_REJECTED,
        message: 'signer did not decide within the permitted window',
      });
      return {
        kind: 'FAILED',
        attemptId: attempt.id,
        code: ErrorCode.SIGNER_REJECTED,
        message: 'signer request expired',
      };
    }

    return this.settleSignature(
      attempt,
      unsignedRequestFrom(attempt),
      state,
      signerRequest.id,
      hooks,
    );
  }

  private async settleSignature(
    attempt: TransactionAttemptRecord,
    request: UnsignedTransactionRequest,
    state: Extract<SignerRequestState, { status: 'SIGNED' | 'REJECTED' }>,
    signerRequestId: string,
    hooks: ChainWriteHooks,
  ): Promise<ChainWriteOutcome> {
    const { db, logger } = this.deps;

    if (state.status === 'REJECTED') {
      await markSignerRequestRefused(db, {
        id: signerRequestId,
        status: 'REJECTED',
        rejectionCode: state.code,
      });
      this.deps.metrics.signerFailures.inc({ reason: state.code });
      await this.failAttempt(attempt, hooks, {
        code: ErrorCode.SIGNER_REJECTED,
        message: `${state.code}: ${state.reason}`,
      });
      return {
        kind: 'FAILED',
        attemptId: attempt.id,
        code: ErrorCode.SIGNER_REJECTED,
        message: state.reason,
      };
    }

    // The signer is untrusted: prove the bytes encode exactly the committed request.
    let verified;
    try {
      verified = await verifySignedTransaction(
        state.signedTransaction,
        request,
        request.from,
        state.transactionHash,
      );
    } catch (error) {
      this.deps.metrics.signerFailures.inc({ reason: ErrorCode.SIGNED_TRANSACTION_MISMATCH });
      await this.failAttempt(attempt, hooks, {
        code: ErrorCode.SIGNED_TRANSACTION_MISMATCH,
        message: error instanceof Error ? error.message : 'signed transaction verification failed',
      });
      throw error;
    }

    // The bytes and hash must be durable before anything is sent, so a crash mid-broadcast
    // can be resolved by looking up this hash or resending these exact bytes.
    await db.transaction(async (tx) => {
      await persistSignedAttempt(tx, {
        attemptId: attempt.id,
        signedRawTransaction: state.signedTransaction,
        transactionHash: verified.transactionHash,
      });
      await markSignerRequestSigned(tx, signerRequestId);
      await hooks.onSigned?.(tx, attempt);
    });

    try {
      await hooks.assertBroadcastAllowed?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'broadcast refused';
      const code = isAppError(error) ? error.code : ErrorCode.INTERNAL_ERROR;
      logger.warn(
        { transactionAttemptId: attempt.id, code },
        'signed transaction withheld; the operation may no longer execute',
      );
      await this.failAttempt(attempt, hooks, { code, message });
      return { kind: 'FAILED', attemptId: attempt.id, code, message };
    }

    // Committing BROADCASTING before the send is what makes a crash here recoverable
    // rather than indistinguishable from "never attempted".
    await db.transaction(async (tx) => {
      await updateAttemptStatus(tx, {
        attemptId: attempt.id,
        status: AttemptStatus.BROADCASTING,
        incrementBroadcastAttempts: true,
      });
      await hooks.onBroadcasting?.(tx, attempt);
    });

    logger.info(
      { attemptId: attempt.id, transactionHash: verified.transactionHash, nonce: attempt.nonce },
      'broadcasting signed transaction',
    );

    return this.broadcast(attempt, state.signedTransaction, verified.transactionHash, hooks);
  }

  /**
   * Sends the exact persisted bytes. Never re-encodes and never re-signs, so this is
   * safe to call again for the same attempt during recovery.
   */
  async broadcast(
    attempt: TransactionAttemptRecord,
    signedTransaction: string,
    transactionHash: string,
    hooks: ChainWriteHooks = {},
  ): Promise<ChainWriteOutcome> {
    const { db, gateway, metrics } = this.deps;

    try {
      await gateway.broadcastRawTransaction(signedTransaction as `0x${string}`);
    } catch (error) {
      const classified = classifyBroadcastError(error);

      if (classified === 'ALREADY_KNOWN') {
        // The node already has this exact transaction. Identical bytes cannot produce a
        // second transfer of value, so this is success, not an error.
        return this.markSubmitted(attempt, transactionHash, hooks);
      }

      if (classified === 'DETERMINISTIC_REJECTION') {
        const message = error instanceof Error ? error.message : String(error);
        await db.transaction(async (tx) => {
          await updateAttemptStatus(tx, {
            attemptId: attempt.id,
            status: AttemptStatus.FAILED,
            errorCode: 'BROADCAST_REJECTED',
            errorMessage: message,
          });
          await hooks.onFailed?.(tx, attempt, { code: 'BROADCAST_REJECTED', message });
        });
        return {
          kind: 'FAILED',
          attemptId: attempt.id,
          code: 'BROADCAST_REJECTED',
          message,
        };
      }

      // Ambiguous: the transaction may or may not be in a mempool. It must NOT be
      // treated as a failure, or we would risk minting the same money twice.
      const reason = error instanceof Error ? error.message : String(error);
      metrics.broadcastUnknownTotal.inc();
      await db.transaction(async (tx) => {
        await updateAttemptStatus(tx, {
          attemptId: attempt.id,
          status: AttemptStatus.BROADCAST_UNKNOWN,
          errorCode: 'BROADCAST_AMBIGUOUS',
          errorMessage: reason,
        });
        await hooks.onBroadcastUnknown?.(tx, attempt, reason);
      });
      this.deps.logger.warn(
        { attemptId: attempt.id, transactionHash },
        'broadcast outcome unknown; recovery will resolve against the chain',
      );
      return { kind: 'BROADCAST_UNKNOWN', attemptId: attempt.id, transactionHash, reason };
    }

    return this.markSubmitted(attempt, transactionHash, hooks);
  }

  private async markSubmitted(
    attempt: TransactionAttemptRecord,
    transactionHash: string,
    hooks: ChainWriteHooks,
  ): Promise<ChainWriteOutcome> {
    await this.deps.db.transaction(async (tx) => {
      await updateAttemptStatus(tx, { attemptId: attempt.id, status: AttemptStatus.SUBMITTED });
      await hooks.onSubmitted?.(tx, attempt, transactionHash);
    });
    return { kind: 'SUBMITTED', attemptId: attempt.id, transactionHash };
  }

  private async failAttempt(
    attempt: TransactionAttemptRecord,
    hooks: ChainWriteHooks,
    failure: { code: string; message: string },
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await updateAttemptStatus(tx, {
        attemptId: attempt.id,
        status: AttemptStatus.FAILED,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      await hooks.onFailed?.(tx, attempt, failure);
    });
  }
}

/** Rebuilds the exact request a persisted attempt represents, for signature verification. */
function unsignedRequestFrom(attempt: TransactionAttemptRecord): UnsignedTransactionRequest {
  return {
    attemptId: attempt.id,
    chainId: attempt.chainId,
    from: attempt.fromAddress as `0x${string}`,
    to: attempt.toAddress as `0x${string}` | null,
    nonce: attempt.nonce,
    value: 0n,
    data: attempt.data as `0x${string}`,
    gasLimit: BigInt(attempt.gasLimit),
    maxFeePerGas: BigInt(attempt.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(attempt.maxPriorityFeePerGas),
  };
}

export type BroadcastErrorClass =
  | 'ALREADY_KNOWN'
  | 'DETERMINISTIC_REJECTION'
  | 'AMBIGUOUS';

/**
 * Decides whether a failed broadcast definitively did not happen.
 *
 * The default is AMBIGUOUS. Only errors that prove the node parsed and rejected the
 * transaction outright are treated as deterministic failures; anything resembling a
 * timeout, socket error or unknown condition keeps the operation recoverable.
 */
export function classifyBroadcastError(error: unknown): BroadcastErrorClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (
    message.includes('already known') ||
    message.includes('already imported') ||
    message.includes('transaction already exists')
  ) {
    return 'ALREADY_KNOWN';
  }

  // A too-low nonce means some transaction with this nonce is already mined. Whether it
  // was ours is unknowable from here, so recovery must look up our hash on chain.
  if (message.includes('nonce too low')) return 'AMBIGUOUS';

  if (
    message.includes('intrinsic gas too low') ||
    message.includes('exceeds block gas limit') ||
    message.includes('invalid sender') ||
    message.includes('rlp') ||
    message.includes('invalid signature') ||
    message.includes('insufficient funds') ||
    message.includes('max fee per gas less than block base fee') ||
    message.includes('transaction type not supported')
  ) {
    return 'DETERMINISTIC_REJECTION';
  }

  return 'AMBIGUOUS';
}
