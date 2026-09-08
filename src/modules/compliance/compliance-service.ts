import type { Database } from '../../db/pool.js';
import type { ComplianceProvider } from '../../ports/compliance-provider.js';
import type { EvmGateway } from '../../ports/evm-gateway.js';
import type { ChainWriter } from '../transactions/chain-writer.js';
import { awaitConfirmation, type ConfirmationPolicy } from '../transactions/confirmation.js';
import {
  findActiveApproval,
  insertComplianceDecision,
  markComplianceChainSyncFailed,
  markComplianceChainSynced,
  supersedeActiveDecisions,
  type ComplianceDecisionRecord,
} from '../../db/repositories/compliance-repository.js';
import { findWalletById } from '../../db/repositories/wallet-repository.js';
import { findAssetById } from '../../db/repositories/asset-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
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
  readonly gateway: EvmGateway;
  readonly chainWriter: ChainWriter;
  readonly confirmation: ConfirmationPolicy;
}

/**
 * Owns compliance decisions and their on-chain eligibility mirror.
 *
 * The stored decision governs whether the workflow will *propose* a mint. The chain's
 * own eligibility mapping is what actually gates execution, so both are maintained and
 * both are re-verified before money moves.
 */
export class ComplianceService {
  constructor(private readonly deps: ComplianceServiceDeps) {}

  async recordDecision(
    ctx: RequestContext,
    input: RecordComplianceInput,
  ): Promise<ComplianceDecisionRecord> {
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

    // Provider call happens with no transaction open.
    const result = await this.deps.provider.screen({
      subjectReference,
      walletAddress: wallet.address,
      chainId: wallet.chainId,
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
    });

    const decision = await this.deps.db.transaction(async (tx) => {
      await supersedeActiveDecisions(tx, wallet.id, input.assetId ?? null);
      const created = await insertComplianceDecision(tx, {
        walletId: wallet.id,
        assetId: input.assetId ?? null,
        status: result.status,
        subjectReference,
        provider: result.provider,
        providerReference: result.providerReference,
        validFrom: result.validFrom,
        validUntil: result.validUntil,
        decidedAt: result.decidedAt,
        decidedBy: ctx.actor.id,
      });
      await recordAuditEvent(tx, {
        actor: ctx.actor,
        action: 'compliance.decision_recorded',
        resourceType: 'compliance_decision',
        resourceId: created.id,
        correlationId: ctx.correlationId,
        metadata: {
          walletId: wallet.id,
          assetId: input.assetId ?? null,
          status: result.status,
          provider: result.provider,
          providerReference: result.providerReference,
          validUntil: result.validUntil.toISOString(),
        },
      });
      return created;
    });

    if (result.status !== 'APPROVED' || input.assetId === undefined) return decision;

    await this.syncOnChainEligibility(ctx, {
      decisionId: decision.id,
      assetId: input.assetId,
      walletId: wallet.id,
      walletAddress: wallet.address,
      eligibleUntil: result.validUntil,
    });

    return decision;
  }

  private async syncOnChainEligibility(
    ctx: RequestContext,
    input: {
      decisionId: string;
      assetId: string;
      walletId: string;
      walletAddress: string;
      eligibleUntil: Date;
    },
  ): Promise<void> {
    const asset = await findAssetById(this.deps.db, input.assetId);
    if (asset === null || asset.contractAddress === null) {
      throw new AppError(ErrorCode.ASSET_NOT_ACTIVE, 'asset has no deployed contract', {
        details: { assetId: input.assetId },
      });
    }

    try {
      const call = this.deps.gateway.encodeSetEligibilityCall(
        asset.contractAddress as `0x${string}`,
        {
          account: input.walletAddress as `0x${string}`,
          eligibleUntil: BigInt(Math.floor(input.eligibleUntil.getTime() / 1000)),
        },
      );

      const outcome = await this.deps.chainWriter.execute({
        purpose: 'SET_ELIGIBILITY',
        call,
        operationId: null,
        assetId: asset.id,
        walletId: input.walletId,
        correlationId: ctx.correlationId,
        evidence: { complianceDecisionId: input.decisionId, actorId: ctx.actor.id },
      });

      if (outcome.kind !== 'SUBMITTED') {
        throw new AppError(ErrorCode.CHAIN_UNAVAILABLE, 'eligibility update was not submitted', {
          details: { outcome: outcome.kind },
        });
      }

      const confirmation = await awaitConfirmation(
        this.deps.gateway,
        outcome.transactionHash as `0x${string}`,
        this.deps.confirmation,
      );
      if (confirmation.kind !== 'CONFIRMED') {
        throw new AppError(ErrorCode.CHAIN_UNAVAILABLE, 'eligibility update did not confirm', {
          details: { outcome: confirmation.kind },
        });
      }

      await this.deps.db.transaction(async (tx) => {
        await markComplianceChainSynced(tx, {
          decisionId: input.decisionId,
          transactionHash: outcome.transactionHash,
        });
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'compliance.eligibility_synced',
          resourceType: 'compliance_decision',
          resourceId: input.decisionId,
          correlationId: ctx.correlationId,
          metadata: {
            assetId: asset.id,
            walletAddress: input.walletAddress,
            transactionHash: outcome.transactionHash,
          },
        });
      });
    } catch (error) {
      await this.deps.db.transaction(async (tx) => {
        await markComplianceChainSyncFailed(tx, input.decisionId);
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'compliance.eligibility_sync_failed',
          resourceType: 'compliance_decision',
          resourceId: input.decisionId,
          correlationId: ctx.correlationId,
          metadata: { reason: error instanceof Error ? error.message : 'unknown' },
        });
      });
      throw error;
    }
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
