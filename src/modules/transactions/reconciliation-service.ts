import type { Database } from '../../db/pool.js';
import type { EvmGateway, TransactionReceiptView } from '../../ports/evm-gateway.js';
import { recordObservation } from '../../db/repositories/transaction-repository.js';
import type { OperationRecord } from '../../db/repositories/operation-repository.js';
import type { Logger } from '../../platform/logging/index.js';

export interface ReconciliationInput {
  readonly operation: OperationRecord;
  readonly attemptId: string;
  readonly contractAddress: `0x${string}`;
  readonly recipient: `0x${string}`;
  readonly receipt: TransactionReceiptView;
}

export interface ReconciliationReport {
  /** True only when every expectation held against canonical chain state. */
  readonly consistent: boolean;
  readonly findings: readonly string[];
  readonly mintedAmount: string | null;
  readonly totalSupply: string | null;
  readonly recipientBalance: string | null;
}

/**
 * Compares PostgreSQL's belief about a mint against canonical chain state.
 *
 * A successful receipt is not sufficient evidence that the intended mint happened: the
 * expected event, the consumption of the single-use operation reference and the
 * recipient's balance are all checked, and every check is persisted as an observation
 * so a mismatch leaves durable evidence rather than only a log line.
 */
export class ReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly gateway: EvmGateway,
    private readonly chainId: number,
    private readonly logger: Logger,
  ) {}

  async reconcileMint(input: ReconciliationInput): Promise<ReconciliationReport> {
    const findings: string[] = [];
    const { operation, receipt } = input;
    const expectedAmount = BigInt(operation.amount);
    const reference = operation.operationReference as `0x${string}`;

    const receiptOk = receipt.status === 'success';
    if (!receiptOk) findings.push('transaction receipt status is reverted');

    await recordObservation(this.db, {
      operationId: operation.id,
      transactionAttemptId: input.attemptId,
      kind: 'RECEIPT',
      chainId: this.chainId,
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      matched: receiptOk,
      expected: { status: 'success' },
      actual: { status: receipt.status, gasUsed: receipt.gasUsed.toString() },
      detail: null,
    });

    // Expected contract event.
    const events = this.gateway.decodeMintExecutedEvents(input.contractAddress, receipt.logs);
    const mintEvent =
      events.find((event) => event.operationReference.toLowerCase() === reference.toLowerCase()) ??
      null;

    const eventOk =
      mintEvent !== null &&
      mintEvent.recipient.toLowerCase() === input.recipient.toLowerCase() &&
      mintEvent.amount === expectedAmount;
    if (!eventOk) {
      findings.push(
        mintEvent === null
          ? 'no MintExecuted event for this operation reference'
          : 'MintExecuted event does not match the approved recipient/amount',
      );
    }

    await recordObservation(this.db, {
      operationId: operation.id,
      transactionAttemptId: input.attemptId,
      kind: 'MINT_EVENT',
      chainId: this.chainId,
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      matched: eventOk,
      expected: {
        operationReference: reference,
        recipient: input.recipient.toLowerCase(),
        amount: operation.amount,
      },
      actual:
        mintEvent === null
          ? null
          : {
              operationReference: mintEvent.operationReference,
              recipient: mintEvent.recipient.toLowerCase(),
              amount: mintEvent.amount.toString(),
              newTotalSupply: mintEvent.newTotalSupply.toString(),
            },
      detail: null,
    });

    // The single-use reference must now be consumed on chain.
    const consumed = await this.gateway.readReferenceConsumed(input.contractAddress, reference);
    if (!consumed) findings.push('operation reference is not marked consumed on chain');
    await recordObservation(this.db, {
      operationId: operation.id,
      transactionAttemptId: input.attemptId,
      kind: 'REFERENCE_CONSUMED',
      chainId: this.chainId,
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      matched: consumed,
      expected: { consumed: true },
      actual: { consumed },
      detail: null,
    });

    const balance = await this.gateway.readBalanceOf(input.contractAddress, input.recipient);
    const balanceOk = balance >= expectedAmount;
    if (!balanceOk) findings.push('recipient balance is smaller than the minted amount');
    await recordObservation(this.db, {
      operationId: operation.id,
      transactionAttemptId: input.attemptId,
      kind: 'RECIPIENT_BALANCE',
      chainId: this.chainId,
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      matched: balanceOk,
      expected: { atLeast: operation.amount },
      actual: { balance: balance.toString() },
      detail: null,
    });

    const tokenState = await this.gateway.readTokenState(input.contractAddress);
    const supplyOk = tokenState.totalSupply <= tokenState.supplyCap;
    if (!supplyOk) findings.push('total supply exceeds the supply cap');
    await recordObservation(this.db, {
      operationId: operation.id,
      transactionAttemptId: input.attemptId,
      kind: 'TOTAL_SUPPLY',
      chainId: this.chainId,
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      matched: supplyOk,
      expected: { atMost: tokenState.supplyCap.toString() },
      actual: { totalSupply: tokenState.totalSupply.toString() },
      detail: null,
    });

    const consistent = receiptOk && eventOk && consumed && balanceOk && supplyOk;
    if (!consistent) {
      this.logger.error(
        { operationId: operation.id, transactionHash: receipt.transactionHash, findings },
        'reconciliation found a mismatch between PostgreSQL and chain state',
      );
    }

    return {
      consistent,
      findings,
      mintedAmount: mintEvent === null ? null : mintEvent.amount.toString(),
      totalSupply: tokenState.totalSupply.toString(),
      recipientBalance: balance.toString(),
    };
  }
}
