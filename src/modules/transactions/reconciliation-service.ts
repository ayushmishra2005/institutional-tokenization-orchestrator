import type { Database } from '../../db/pool.js';
import type { EvmGateway, TransactionReceiptView } from '../../ports/evm-gateway.js';
import {
  recordObservation,
  type ObservationKind,
  type ObservationSeverity,
} from '../../db/repositories/transaction-repository.js';
import type { OperationRecord } from '../../db/repositories/operation-repository.js';
import type { Logger } from '../../platform/logging/index.js';

export interface ReconciliationReport {
  /** True only when every expectation held against canonical chain state. */
  readonly consistent: boolean;
  readonly findings: readonly string[];
  /** Chain values worth keeping in the settlement audit event. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface MintReconciliationInput {
  readonly operation: OperationRecord;
  readonly attemptId: string;
  readonly contractAddress: `0x${string}`;
  readonly recipient: `0x${string}`;
  readonly amount: string;
  readonly operationReference: `0x${string}`;
  readonly receipt: TransactionReceiptView;
}

interface Check {
  readonly kind: ObservationKind;
  readonly matched: boolean;
  /** CRITICAL means the evidence contradicts our belief about money or authority. */
  readonly severity: ObservationSeverity;
  readonly expected: unknown;
  readonly actual: unknown;
  /** Recorded and reported when the check does not hold. */
  readonly finding: string;
}

/** Collects checks for one operation so each method reads as a list of expectations. */
class ChecklistRun {
  readonly findings: string[] = [];

  constructor(
    private readonly write: (check: Check) => Promise<void>,
  ) {}

  async check(check: Check): Promise<boolean> {
    await this.write(check);
    if (!check.matched) this.findings.push(check.finding);
    return check.matched;
  }
}

/**
 * Compares PostgreSQL's belief about a chain write against canonical chain state.
 *
 * A successful receipt is never sufficient evidence on its own. Every check below is
 * persisted as an observation, so a mismatch leaves durable evidence rather than a log
 * line, and the caller can refuse to claim success without discarding what it learned.
 */
export class ReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly gateway: EvmGateway,
    private readonly chainId: number,
    private readonly logger: Logger,
  ) {}

  async reconcileMint(input: MintReconciliationInput): Promise<ReconciliationReport> {
    const { operation, receipt, contractAddress, recipient } = input;
    const expectedAmount = BigInt(input.amount);
    const reference = input.operationReference;
    const run = this.checklist(operation, input.attemptId, receipt);

    const identity = await this.gateway.getChainIdentity();
    const identityOk = identity.chainId === this.chainId;
    await run.check({
      kind: 'CHAIN_IDENTITY',
      matched: identityOk,
      severity: 'CRITICAL',
      expected: { chainId: this.chainId },
      actual: { chainId: identity.chainId },
      finding: 'RPC endpoint reports a different chain than the operation was built for',
    });

    const receiptOk = receipt.status === 'success';
    await run.check({
      kind: 'RECEIPT',
      matched: receiptOk,
      severity: 'CRITICAL',
      expected: { status: 'success', blockNumberPresent: true },
      actual: {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
      },
      finding: 'transaction receipt status is reverted',
    });

    const events = this.gateway.decodeMintExecutedEvents(contractAddress, receipt.logs);
    const mintEvent =
      events.find((event) => event.operationReference.toLowerCase() === reference.toLowerCase()) ??
      null;
    const eventOk =
      mintEvent !== null &&
      mintEvent.recipient.toLowerCase() === recipient.toLowerCase() &&
      mintEvent.amount === expectedAmount;
    await run.check({
      kind: 'MINT_EVENT',
      matched: eventOk,
      severity: 'CRITICAL',
      expected: {
        operationReference: reference,
        recipient: recipient.toLowerCase(),
        amount: input.amount,
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
      finding:
        mintEvent === null
          ? 'no MintExecuted event for this operation reference'
          : 'MintExecuted event does not match the approved recipient/amount',
    });

    const consumed = await this.gateway.readReferenceConsumed(contractAddress, reference);
    await run.check({
      kind: 'REFERENCE_CONSUMED',
      matched: consumed,
      severity: 'CRITICAL',
      expected: { consumed: true },
      actual: { consumed },
      finding: 'operation reference is not marked consumed on chain',
    });

    const balance = await this.gateway.readBalanceOf(contractAddress, recipient);
    await run.check({
      kind: 'RECIPIENT_BALANCE',
      matched: balance >= expectedAmount,
      severity: 'CRITICAL',
      expected: { atLeast: input.amount },
      actual: { balance: balance.toString() },
      finding: 'recipient balance is smaller than the minted amount',
    });

    const tokenState = await this.gateway.readTokenState(contractAddress);
    await run.check({
      kind: 'TOTAL_SUPPLY',
      matched: tokenState.totalSupply <= tokenState.supplyCap,
      severity: 'CRITICAL',
      expected: { atMost: tokenState.supplyCap.toString() },
      actual: { totalSupply: tokenState.totalSupply.toString() },
      finding: 'total supply exceeds the supply cap',
    });

    return this.report(operation, receipt, run.findings, {
      mintedAmount: mintEvent === null ? null : mintEvent.amount.toString(),
      recipientBalance: balance.toString(),
      totalSupply: tokenState.totalSupply.toString(),
    });
  }

  async reconcileDeployment(input: {
    operation: OperationRecord;
    attemptId: string;
    receipt: TransactionReceiptView;
    expected: { symbol: string; decimals: number; supplyCap: string };
  }): Promise<ReconciliationReport> {
    const { operation, receipt } = input;
    const run = this.checklist(operation, input.attemptId, receipt);
    const contractAddress = receipt.contractAddress;

    const receiptOk = await run.check({
      kind: 'RECEIPT',
      matched: receipt.status === 'success' && contractAddress !== null,
      severity: 'CRITICAL',
      expected: { status: 'success', contractAddressPresent: true },
      actual: { status: receipt.status, contractAddress },
      finding: 'deployment receipt did not succeed or reported no contract address',
    });
    if (!receiptOk || contractAddress === null) {
      return this.report(operation, receipt, run.findings, { contractAddress });
    }

    // A receipt naming an address is not proof that code is there; confirm independently.
    const codePresent = await this.gateway
      .assertContractDeployed(contractAddress)
      .then(() => true)
      .catch(() => false);
    await run.check({
      kind: 'CONTRACT_CODE',
      matched: codePresent,
      severity: 'CRITICAL',
      expected: { codeAt: contractAddress },
      actual: { codePresent },
      finding: 'no contract code found at the deployed address',
    });
    if (!codePresent) return this.report(operation, receipt, run.findings, { contractAddress });

    // The deployed token must be the one that was asked for, or the asset row would start
    // describing a contract whose supply cap and decimals nobody approved.
    const token = await this.gateway.readTokenState(contractAddress);
    await run.check({
      kind: 'TOKEN_METADATA',
      matched:
        token.symbol === input.expected.symbol &&
        token.decimals === input.expected.decimals &&
        token.supplyCap === BigInt(input.expected.supplyCap) &&
        token.totalSupply === 0n &&
        !token.paused,
      severity: 'CRITICAL',
      expected: { ...input.expected, totalSupply: '0', paused: false },
      actual: {
        symbol: token.symbol,
        decimals: token.decimals,
        supplyCap: token.supplyCap.toString(),
        totalSupply: token.totalSupply.toString(),
        paused: token.paused,
      },
      finding: 'deployed token does not match the requested definition',
    });

    return this.report(operation, receipt, run.findings, { contractAddress });
  }

  async reconcileEligibility(input: {
    operation: OperationRecord;
    attemptId: string;
    receipt: TransactionReceiptView;
    contractAddress: `0x${string}`;
    account: `0x${string}`;
    expectedEligibleUntil: bigint;
  }): Promise<ReconciliationReport> {
    const { operation, receipt } = input;
    const run = this.checklist(operation, input.attemptId, receipt);

    await run.check({
      kind: 'RECEIPT',
      matched: receipt.status === 'success',
      severity: 'CRITICAL',
      expected: { status: 'success' },
      actual: { status: receipt.status, blockNumber: receipt.blockNumber },
      finding: 'eligibility receipt status is reverted',
    });

    const onChain = await this.gateway.readEligibleUntil(input.contractAddress, input.account);
    await run.check({
      kind: 'ELIGIBILITY_WINDOW',
      matched: onChain === input.expectedEligibleUntil,
      severity: 'CRITICAL',
      expected: { eligibleUntil: input.expectedEligibleUntil.toString() },
      actual: { eligibleUntil: onChain.toString() },
      finding: 'on-chain eligibility window does not match the compliance decision',
    });

    return this.report(operation, receipt, run.findings, {
      account: input.account,
      eligibleUntil: onChain.toString(),
    });
  }

  private checklist(
    operation: OperationRecord,
    attemptId: string,
    receipt: TransactionReceiptView,
  ): ChecklistRun {
    return new ChecklistRun(async (check) => {
      await recordObservation(this.db, {
        operationId: operation.id,
        transactionAttemptId: attemptId,
        kind: check.kind,
        chainId: this.chainId,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        matched: check.matched,
        severity: check.matched ? 'INFO' : check.severity,
        expected: check.expected,
        actual: check.actual,
        detail: check.matched ? null : check.finding,
      });
    });
  }

  private report(
    operation: OperationRecord,
    receipt: TransactionReceiptView,
    findings: string[],
    evidence: Record<string, unknown>,
  ): ReconciliationReport {
    if (findings.length > 0) {
      this.logger.error(
        {
          operationId: operation.id,
          operationType: operation.type,
          transactionHash: receipt.transactionHash,
          findings,
        },
        'reconciliation found a mismatch between PostgreSQL and chain state',
      );
    }
    return { consistent: findings.length === 0, findings, evidence };
  }
}
