import type { Database, Transaction } from '../../db/pool.js';
import type { EvmGateway, EncodedCall, FeeEstimate } from '../../ports/evm-gateway.js';
import type {
  SignerProvider,
  SignerRequestState,
  UnsignedTransactionRequest,
} from '../../ports/signer-provider.js';
import { verifySignedTransaction } from '../../adapters/evm/signed-transaction-verifier.js';
import {
  AttemptStatus,
  findAttemptById,
  insertPreparedAttempt,
  linkAttemptReplacement,
  persistSignedAttempt,
  retireAttemptForReplacement,
  reserveNonce,
  updateAttemptStatus,
  type AttemptPurpose,
  type TransactionAttemptRecord,
} from '../../db/repositories/transaction-repository.js';
import {
  assertFeeOnlyReplacement,
  fingerprintOf,
  intentFingerprint,
} from './transaction-intent.js';
import {
  expireLapsedSignerRequest,
  findSignerRequestForAttempt,
  markSignerRequestRejected,
  markSignerRequestSigned,
  recordSignerRequest,
  touchSignerRequest,
} from '../../db/repositories/signer-request-repository.js';
import { AppError, ErrorCode, isAppError } from '../../domain/errors.js';
import { canonicalHash } from '../../domain/canonical.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';
import type { ReplacementPolicy } from '../../platform/config/chain-profile.js';

/** Multiplier applied to the simulated gas estimate to absorb small state drift. */
const GAS_BUFFER_NUMERATOR = 5n;
const GAS_BUFFER_DENOMINATOR = 4n;

/** A zero-value self-transfer costs 21000; the rest is headroom for fee-market drift. */
const NONCE_RECOVERY_GAS_LIMIT = 30_000;

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
  readonly replacement: ReplacementPolicy;
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

      const fingerprint = intentFingerprint({
        chainId: this.deps.chainId,
        from: signerAddress,
        to: intent.call.to,
        data: intent.call.data,
        value: '0',
        purpose: intent.purpose,
        operationId: intent.operationId,
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
        intentFingerprint: fingerprint,
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
   * Replaces a stuck attempt with the same intent at a higher fee.
   *
   * Destination, calldata, value and nonce are copied from the stuck row rather than
   * rebuilt, so there is no code path through which a replacement could carry a different
   * financial effect than the one that was approved.
   */
  async replaceFees(
    previous: TransactionAttemptRecord,
    input: { fees: FeeEstimate; reason: string; correlationId: string },
    hooks: ChainWriteHooks = {},
  ): Promise<ChainWriteOutcome> {
    if (previous.replacementNumber >= this.deps.replacement.maxReplacements) {
      throw new AppError(
        ErrorCode.REPLACEMENT_LIMIT_REACHED,
        'replacement limit reached for this transaction',
        { details: { attemptId: previous.id, replacementNumber: previous.replacementNumber } },
      );
    }

    const candidate = {
      operationId: previous.operationId,
      assetId: previous.assetId,
      walletId: previous.walletId,
      purpose: previous.purpose as AttemptPurpose,
      chainId: previous.chainId,
      fromAddress: previous.fromAddress,
      toAddress: previous.toAddress,
      nonce: previous.nonce,
      data: previous.data,
      value: previous.value,
    };
    assertFeeOnlyReplacement(previous, candidate);

    if (
      BigInt(input.fees.maxFeePerGas) <= BigInt(previous.maxFeePerGas) ||
      BigInt(input.fees.maxPriorityFeePerGas) <= BigInt(previous.maxPriorityFeePerGas)
    ) {
      throw new AppError(
        ErrorCode.REPLACEMENT_INTENT_MISMATCH,
        'a replacement must raise both fee fields',
        { details: { attemptId: previous.id } },
      );
    }

    return this.signReplacement(previous, {
      ...candidate,
      gasLimit: previous.gasLimit,
      fees: input.fees,
      intentFingerprint: fingerprintOf(previous),
      reason: input.reason,
      correlationId: input.correlationId,
      evidence: {
        replacesAttemptId: previous.id,
        replacementReason: input.reason,
        replacementNumber: previous.replacementNumber + 1,
      },
      hooks,
    });
  }

  /**
   * Clears a nonce held by an attempt that must never be broadcast, using a zero-value
   * transaction from the signer to itself at that exact nonce. The nonce is not skipped:
   * the chain has to see something at that number before later transactions can be mined.
   */
  async cancelNonce(
    blocked: TransactionAttemptRecord,
    input: { fees: FeeEstimate; reason: string; correlationId: string },
    hooks: ChainWriteHooks = {},
  ): Promise<ChainWriteOutcome> {
    const signerAddress = await this.deps.signer.getSignerAddress();
    if (signerAddress.toLowerCase() !== blocked.fromAddress.toLowerCase()) {
      throw new AppError(
        ErrorCode.REPLACEMENT_INTENT_MISMATCH,
        'nonce recovery must be signed by the lane owner',
        { details: { lane: blocked.fromAddress, signer: signerAddress } },
      );
    }

    const candidate = {
      operationId: null,
      assetId: blocked.assetId,
      walletId: blocked.walletId,
      purpose: 'NONCE_RECOVERY' as AttemptPurpose,
      chainId: blocked.chainId,
      fromAddress: signerAddress,
      toAddress: signerAddress,
      nonce: blocked.nonce,
      data: '0x',
      value: '0',
    };

    return this.signReplacement(blocked, {
      ...candidate,
      gasLimit: NONCE_RECOVERY_GAS_LIMIT,
      fees: input.fees,
      intentFingerprint: intentFingerprint({
        chainId: candidate.chainId,
        from: candidate.fromAddress,
        to: candidate.toAddress,
        data: candidate.data,
        value: candidate.value,
        purpose: candidate.purpose,
        operationId: null,
      }),
      reason: input.reason,
      correlationId: input.correlationId,
      evidence: { recoversAttemptId: blocked.id, blockedNonce: blocked.nonce },
      hooks,
    });
  }

  private async signReplacement(
    previous: TransactionAttemptRecord,
    input: {
      operationId: string | null;
      assetId: string | null;
      walletId: string | null;
      purpose: AttemptPurpose;
      chainId: number;
      fromAddress: string;
      toAddress: string | null;
      nonce: number;
      data: string;
      gasLimit: number;
      fees: FeeEstimate;
      intentFingerprint: string;
      reason: string;
      correlationId: string;
      evidence: Readonly<Record<string, unknown>>;
      hooks: ChainWriteHooks;
    },
  ): Promise<ChainWriteOutcome> {
    const { db, signer } = this.deps;

    const requestHash = canonicalHash({
      chainId: input.chainId,
      from: input.fromAddress.toLowerCase(),
      to: input.toAddress === null ? null : input.toAddress.toLowerCase(),
      nonce: input.nonce,
      value: '0',
      data: input.data.toLowerCase(),
      gasLimit: input.gasLimit.toString(),
      maxFeePerGas: input.fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: input.fees.maxPriorityFeePerGas.toString(),
    });

    // Retire, insert, then link: the lane's unique index only ignores REPLACED rows, so
    // the old attempt has to leave the index before the new one can occupy the nonce.
    const attempt = await db.transaction(async (tx) => {
      const retired = await retireAttemptForReplacement(tx, {
        attemptId: previous.id,
        reason: input.reason,
      });
      if (!retired) {
        throw new AppError(
          ErrorCode.OPERATION_CONFLICT,
          'the attempt was already replaced by another dispatcher',
          { details: { attemptId: previous.id } },
        );
      }

      const inserted = await insertPreparedAttempt(tx, {
        operationId: input.operationId,
        assetId: input.assetId,
        walletId: input.walletId,
        purpose: input.purpose,
        chainId: input.chainId,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        nonce: input.nonce,
        data: input.data,
        gasLimit: input.gasLimit,
        maxFeePerGas: input.fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: input.fees.maxPriorityFeePerGas.toString(),
        requestHash,
        intentFingerprint: input.intentFingerprint,
        replacesAttemptId: previous.id,
        replacementReason: input.reason,
        replacementNumber: previous.replacementNumber + 1,
      });

      await linkAttemptReplacement(tx, { attemptId: previous.id, replacementId: inserted.id });
      await input.hooks.onPrepared?.(tx, inserted);
      return inserted;
    });

    const request = unsignedRequestFrom(attempt);
    const state = await signer.requestSignature(request, {
      purpose: input.purpose,
      ...(input.operationId === null ? {} : { operationId: input.operationId }),
      ...(input.assetId === null ? {} : { assetId: input.assetId }),
      correlationId: input.correlationId,
      evidence: input.evidence,
    });

    const signerRequest = await recordSignerRequest(db, {
      transactionAttemptId: attempt.id,
      operationId: input.operationId,
      provider: signer.name,
      providerRequestId: state.providerRequestId,
      status: state.status,
      requestFingerprint: attempt.requestHash,
    });
    this.deps.metrics.signerRequests.inc({ provider: signer.name, outcome: state.status });

    if (state.status === 'PENDING') {
      return {
        kind: 'SIGNATURE_PENDING',
        attemptId: attempt.id,
        providerRequestId: state.providerRequestId,
      };
    }

    return this.settleSignature(attempt, request, state, signerRequest.id, input.hooks);
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

    // Checked before the provider is contacted: a lapsed request must retire even while
    // the provider is unreachable, and a signature released afterwards must not revive it.
    const expired = await expireLapsedSignerRequest(db, {
      id: signerRequest.id,
      timeoutMs: this.deps.signerRequestTimeoutMs,
    });
    if (expired) {
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

    const state = await signer.fetchSignature(signerRequest.providerRequestId);
    await touchSignerRequest(db, signerRequest.id);

    if (state.status === 'PENDING') {
      return {
        kind: 'SIGNATURE_PENDING',
        attemptId: attempt.id,
        providerRequestId: signerRequest.providerRequestId,
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
      await markSignerRequestRejected(db, { id: signerRequestId, rejectionCode: state.code });
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

    // A worker that has been holding this attempt while another replaced it must not put
    // the superseded bytes on the wire: the nonce now belongs to the replacement.
    const current = await findAttemptById(db, attempt.id);
    if (current === null || current.status === AttemptStatus.REPLACED) {
      this.deps.logger.warn(
        { transactionAttemptId: attempt.id, nonce: attempt.nonce },
        'refusing to broadcast a superseded attempt',
      );
      return {
        kind: 'FAILED',
        attemptId: attempt.id,
        code: 'ATTEMPT_SUPERSEDED',
        message: 'the attempt was replaced before this broadcast',
      };
    }

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
