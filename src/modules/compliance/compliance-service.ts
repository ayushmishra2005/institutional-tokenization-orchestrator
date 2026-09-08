import type { Database, Transaction } from '../../db/pool.js';
import type { ComplianceProvider } from '../../ports/compliance-provider.js';
import {
  findActiveApproval,
  insertComplianceDecision,
  supersedeActiveDecisions,
  type ComplianceDecisionRecord,
} from '../../db/repositories/compliance-repository.js';
import { findWalletById, type WalletRecord } from '../../db/repositories/wallet-repository.js';
import { findAssetById } from '../../db/repositories/asset-repository.js';
import {
  insertAdministrativeOperation,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import { enqueueOutbox, OutboxTopic } from '../../db/repositories/outbox-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { hashEligibilitySyncIntent } from '../operations/administrative-intent.js';
import type { RequestContext } from '../context.js';

export interface RecordComplianceInput {
  readonly walletId: string;
  /** When present, on-chain eligibility is synced to that asset's token contract. */
  readonly assetId?: string | undefined;
  readonly subjectReference?: string | undefined;
}

export interface ComplianceServiceDeps {
  readonly db: Database;
  readonly provider: ComplianceProvider;
}

export interface RecordComplianceResult {
  readonly decision: ComplianceDecisionRecord;
  /** Set when the decision requires an on-chain eligibility write. */
  readonly operationId: string | null;
}

/**
 * Owns compliance decisions and their on-chain eligibility mirror.
 *
 * The stored decision governs whether the workflow will *propose* a mint; the chain's own
 * eligibility mapping is what gates execution. Both are maintained and both are re-verified
 * before money moves. The chain write itself is an operation carried out by the worker.
 */
export class ComplianceService {
  constructor(private readonly deps: ComplianceServiceDeps) {}

  async recordDecision(
    ctx: RequestContext,
    input: RecordComplianceInput,
  ): Promise<RecordComplianceResult> {
    requireRole(
      ctx.actor,
      [AppRole.COMPLIANCE_OFFICER, AppRole.ADMIN],
      'record a compliance decision',
    );

    const wallet = await findWalletById(this.deps.db, input.walletId);
    if (wallet === null || wallet.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('wallet', input.walletId);
    }

    const subjectReference = input.subjectReference ?? wallet.investorReference;

    // The provider is called with no transaction open.
    const screening = await this.deps.provider.screen({
      subjectReference,
      walletAddress: wallet.address,
      chainId: wallet.chainId,
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
    });

    const syncRequired = screening.status === 'APPROVED' && input.assetId !== undefined;
    const asset = syncRequired ? await findAssetById(this.deps.db, input.assetId as string) : null;
    if (syncRequired && (asset === null || asset.contractAddress === null)) {
      throw new AppError(ErrorCode.ASSET_NOT_ACTIVE, 'asset has no deployed contract', {
        details: { assetId: input.assetId },
      });
    }

    return this.deps.db.transaction(async (tx) => {
      await supersedeActiveDecisions(tx, wallet.id, input.assetId ?? null);
      const decision = await insertComplianceDecision(tx, {
        walletId: wallet.id,
        assetId: input.assetId ?? null,
        status: screening.status,
        subjectReference,
        provider: screening.provider,
        providerReference: screening.providerReference,
        validFrom: screening.validFrom,
        validUntil: screening.validUntil,
        decidedAt: screening.decidedAt,
        decidedBy: ctx.actor.id,
      });

      const operation =
        asset === null
          ? null
          : await this.enqueueEligibilitySync(tx, ctx, {
              assetId: asset.id,
              chainId: asset.chainId,
              wallet,
              decision,
            });

      await recordAuditEvent(tx, {
        actor: ctx.actor,
        action: 'compliance.decision_recorded',
        resourceType: 'compliance_decision',
        resourceId: decision.id,
        ...(operation === null ? {} : { operationId: operation.id }),
        correlationId: ctx.correlationId,
        metadata: {
          walletId: wallet.id,
          assetId: input.assetId ?? null,
          status: screening.status,
          provider: screening.provider,
          providerReference: screening.providerReference,
          validUntil: screening.validUntil.toISOString(),
          eligibilityOperationId: operation?.id ?? null,
        },
      });

      return { decision, operationId: operation?.id ?? null };
    });
  }

  private async enqueueEligibilitySync(
    tx: Transaction,
    ctx: RequestContext,
    input: {
      assetId: string;
      chainId: number;
      wallet: WalletRecord;
      decision: ComplianceDecisionRecord;
    },
  ): Promise<OperationRecord> {
    const eligibleUntil = BigInt(Math.floor(input.decision.validUntil.getTime() / 1000));
    const operation = await insertAdministrativeOperation(tx, {
      type: 'SYNC_ELIGIBILITY',
      organizationId: ctx.actor.organizationId,
      assetId: input.assetId,
      walletId: input.wallet.id,
      complianceDecisionId: input.decision.id,
      proposalHash: hashEligibilitySyncIntent({
        assetId: input.assetId,
        chainId: input.chainId,
        walletId: input.wallet.id,
        walletAddress: input.wallet.address,
        complianceDecisionId: input.decision.id,
        eligibleUntil: eligibleUntil.toString(),
      }),
      requestedBy: ctx.actor.id,
      correlationId: ctx.correlationId,
    });

    await enqueueOutbox(tx, {
      topic: OutboxTopic.OPERATION_READY,
      aggregateType: 'operation',
      aggregateId: operation.id,
      payload: { operationId: operation.id },
      correlationId: ctx.correlationId,
    });

    return operation;
  }

  /**
   * Fresh eligibility check performed immediately before execution.
   *
   * Both the durable decision and the provider are consulted: an approval recorded at
   * request time is not sufficient evidence at execution time.
   */
  async assertEligibleForExecution(input: {
    walletId: string;
    walletAddress: string;
    chainId: number;
    assetId: string;
    amount: string;
    subjectReference: string;
  }): Promise<{ decisionId: string; providerReference: string }> {
    const decision = await findActiveApproval(this.deps.db, {
      walletId: input.walletId,
      assetId: input.assetId,
      at: new Date(),
    });
    if (decision === null) {
      throw new AppError(
        ErrorCode.COMPLIANCE_NOT_ELIGIBLE,
        'no valid compliance approval covers this wallet',
        { details: { walletId: input.walletId, assetId: input.assetId } },
      );
    }

    const fresh = await this.deps.provider.checkEligibility({
      subjectReference: input.subjectReference,
      walletAddress: input.walletAddress,
      chainId: input.chainId,
      assetId: input.assetId,
      amount: input.amount,
    });
    if (!fresh.eligible) {
      throw new AppError(
        ErrorCode.COMPLIANCE_NOT_ELIGIBLE,
        fresh.reason ?? 'wallet is not eligible at execution time',
        { details: { walletId: input.walletId, provider: fresh.provider } },
      );
    }

    return { decisionId: decision.id, providerReference: fresh.providerReference };
  }

  async findActiveDecision(
    walletId: string,
    assetId: string | null,
  ): Promise<ComplianceDecisionRecord | null> {
    return findActiveApproval(this.deps.db, { walletId, assetId, at: new Date() });
  }
}
