import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '../../db/pool.js';
import type { ComplianceProvider } from '../../ports/compliance-provider.js';
import {
  findActiveApproval,
  findLapsedApprovals,
  findLatestRevocation,
  insertComplianceDecision,
  markDecisionExpired,
  supersedeActiveDecisions,
  type ComplianceDecisionRecord,
} from '../../db/repositories/compliance-repository.js';
import { findWalletById, type WalletRecord } from '../../db/repositories/wallet-repository.js';
import { findAssetById } from '../../db/repositories/asset-repository.js';
import {
  findLiveAdministrativeOperation,
  insertAdministrativeOperation,
  lockOperation,
  transitionOperation,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import { enqueueOutbox, OutboxTopic } from '../../db/repositories/outbox-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError } from '../../domain/errors.js';
import { AppRole, systemActor } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { OperationState } from '../../domain/operation-state.js';
import { eligibleUntilFor, hashEligibilitySyncIntent } from '../operations/administrative-intent.js';
import type { RequestContext } from '../context.js';
import type { Metrics } from '../../platform/metrics/index.js';

export interface RecordComplianceInput {
  readonly walletId: string;
  /** When present, on-chain eligibility is synced to that asset's token contract. */
  readonly assetId?: string | undefined;
  readonly subjectReference?: string | undefined;
}

export interface ComplianceServiceDeps {
  readonly db: Database;
  readonly provider: ComplianceProvider;
  readonly metrics: Metrics;
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
          : await this.enqueueEligibilitySync(tx, {
              assetId: asset.id,
              chainId: asset.chainId,
              wallet,
              decision,
              requestedBy: ctx.actor.id,
              correlationId: ctx.correlationId,
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

  /**
   * Withdraws a live approval and queues the on-chain eligibility revocation. Repeating
   * the call is harmless: a wallet with no live approval is already revoked, and the
   * existing revocation operation is returned instead of a second chain write.
   */
  async revokeDecision(
    ctx: RequestContext,
    input: { walletId: string; assetId?: string | undefined; reason: string },
  ): Promise<RecordComplianceResult> {
    requireRole(ctx.actor, [AppRole.COMPLIANCE_OFFICER, AppRole.ADMIN], 'revoke compliance');

    const wallet = await findWalletById(this.deps.db, input.walletId);
    if (wallet === null || wallet.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('wallet', input.walletId);
    }

    const assetId = input.assetId ?? null;
    const asset = assetId === null ? null : await findAssetById(this.deps.db, assetId);
    if (assetId !== null && (asset === null || asset.contractAddress === null)) {
      throw new AppError(ErrorCode.ASSET_NOT_ACTIVE, 'asset has no deployed contract', {
        details: { assetId },
      });
    }

    return this.deps.db.transaction(async (tx) => {
      const live = await findActiveApproval(tx, { walletId: wallet.id, assetId, at: new Date() });
      const existingRevocation = await findLatestRevocation(tx, wallet.id, assetId);
      if (live === null && existingRevocation !== null) {
        const inFlight =
          asset === null
            ? null
            : await findLiveAdministrativeOperation(tx, {
                type: 'SYNC_ELIGIBILITY',
                assetId: asset.id,
                walletId: wallet.id,
              });
        return { decision: existingRevocation, operationId: inFlight?.id ?? null };
      }

      if (live !== null) await supersedeActiveDecisions(tx, wallet.id, assetId);

      const revocation = await insertComplianceDecision(tx, {
        walletId: wallet.id,
        assetId,
        status: 'REVOKED',
        subjectReference: live?.subjectReference ?? wallet.investorReference,
        provider: live?.provider ?? this.deps.provider.name,
        providerReference: `revocation-${randomUUID()}`,
        // A revocation grants no validity. The window is degenerate because the table
        // requires valid_until > valid_from; nothing reads it for a REVOKED row.
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 1000),
        decidedAt: new Date(),
        decidedBy: ctx.actor.id,
        revokedAt: new Date(),
        revocationReason: input.reason,
      });

      const operation =
        asset === null
          ? null
          : await this.enqueueEligibilitySync(tx, {
              assetId: asset.id,
              chainId: asset.chainId,
              wallet,
              decision: revocation,
              requestedBy: ctx.actor.id,
              correlationId: ctx.correlationId,
            });

      await recordAuditEvent(tx, {
        actor: ctx.actor,
        action: 'compliance.revoked',
        resourceType: 'compliance_decision',
        resourceId: revocation.id,
        ...(operation === null ? {} : { operationId: operation.id }),
        correlationId: ctx.correlationId,
        metadata: {
          walletId: wallet.id,
          assetId,
          reason: input.reason,
          supersededDecisionId: live?.id ?? null,
          eligibilityOperationId: operation?.id ?? null,
        },
      });

      this.deps.metrics.complianceChecks.inc({ outcome: 'revoked' });
      return { decision: revocation, operationId: operation?.id ?? null };
    });
  }

  /**
   * Retires approvals whose validity window has closed and queues the matching on-chain
   * revocation, so an approval cannot outlive itself just because nobody asked.
   */
  async expireLapsedApprovals(limit = 25): Promise<number> {
    const lapsed = await findLapsedApprovals(this.deps.db, limit);
    let expired = 0;

    for (const decision of lapsed) {
      const wallet = await findWalletById(this.deps.db, decision.walletId);
      const asset =
        decision.assetId === null ? null : await findAssetById(this.deps.db, decision.assetId);
      if (wallet === null) continue;

      await this.deps.db.transaction(async (tx) => {
        await markDecisionExpired(tx, decision.id);
        const operation =
          asset === null || asset.contractAddress === null
            ? null
            : await this.enqueueEligibilitySync(tx, {
                assetId: asset.id,
                chainId: asset.chainId,
                wallet,
                decision: { ...decision, status: 'EXPIRED' },
                // The officer who granted the approval remains the requester of its
                // withdrawal; the sweep is not a user.
                requestedBy: decision.decidedBy,
                correlationId: `compliance-expiry-${decision.id}`,
              });

        await recordAuditEvent(tx, {
          actor: systemActor('compliance-sweep'),
          action: 'compliance.expired',
          resourceType: 'compliance_decision',
          resourceId: decision.id,
          ...(operation === null ? {} : { operationId: operation.id }),
          correlationId: `compliance-expiry-${decision.id}`,
          metadata: {
            walletId: decision.walletId,
            assetId: decision.assetId,
            validUntil: decision.validUntil.toISOString(),
            eligibilityOperationId: operation?.id ?? null,
          },
        });
      });
      this.deps.metrics.complianceChecks.inc({ outcome: 'expired' });
      expired += 1;
    }

    return expired;
  }

  private async enqueueEligibilitySync(
    tx: Transaction,
    input: {
      assetId: string;
      chainId: number;
      wallet: WalletRecord;
      decision: ComplianceDecisionRecord;
      requestedBy: string;
      correlationId: string;
    },
  ): Promise<OperationRecord> {
    await this.clearLiveEligibilitySync(tx, input.assetId, input.wallet.id);

    const eligibleUntil = eligibleUntilFor(input.decision);
    const operation = await insertAdministrativeOperation(tx, {
      type: 'SYNC_ELIGIBILITY',
      organizationId: input.wallet.organizationId,
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
      requestedBy: input.requestedBy,
      correlationId: input.correlationId,
    });

    await enqueueOutbox(tx, {
      topic: OutboxTopic.OPERATION_READY,
      aggregateType: 'operation',
      aggregateId: operation.id,
      payload: { operationId: operation.id },
      correlationId: input.correlationId,
    });

    return operation;
  }

  /**
   * Only one eligibility sync may be live per wallet and asset. A sync that has not been
   * picked up yet is cancelled so the newer decision wins; one that is already signing or
   * on chain is left alone, because the chain does not take instructions back.
   */
  private async clearLiveEligibilitySync(
    tx: Transaction,
    assetId: string,
    walletId: string,
  ): Promise<void> {
    const live = await findLiveAdministrativeOperation(tx, {
      type: 'SYNC_ELIGIBILITY',
      assetId,
      walletId,
    });
    if (live === null) return;

    const locked = await lockOperation(tx, live.id);
    if (locked === null) return;
    if (locked.state !== OperationState.READY) {
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'an eligibility sync for this wallet is already executing',
        { details: { operationId: locked.id, state: locked.state } },
      );
    }

    await transitionOperation(tx, {
      operation: locked,
      to: OperationState.CANCELLED,
      patch: {
        failureCode: 'SUPERSEDED_BY_NEWER_DECISION',
        failureReason: 'a newer compliance decision replaced this eligibility sync',
      },
    });
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
      this.deps.metrics.complianceChecks.inc({ outcome: 'no_live_approval' });
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
      this.deps.metrics.complianceChecks.inc({ outcome: 'not_eligible' });
      throw new AppError(
        ErrorCode.COMPLIANCE_NOT_ELIGIBLE,
        fresh.reason ?? 'wallet is not eligible at execution time',
        { details: { walletId: input.walletId, provider: fresh.provider } },
      );
    }

    this.deps.metrics.complianceChecks.inc({ outcome: 'eligible' });
    return { decisionId: decision.id, providerReference: fresh.providerReference };
  }

  async findActiveDecision(
    walletId: string,
    assetId: string | null,
  ): Promise<ComplianceDecisionRecord | null> {
    return findActiveApproval(this.deps.db, { walletId, assetId, at: new Date() });
  }
}
