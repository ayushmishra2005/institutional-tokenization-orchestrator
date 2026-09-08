import { createHash } from 'node:crypto';
import {
  ComplianceStatus,
  type ComplianceDecisionResult,
  type ComplianceEligibilityRequest,
  type ComplianceEligibilityResult,
  type ComplianceProvider,
  type ComplianceScreenRequest,
} from '../../ports/compliance-provider.js';

export interface MockComplianceOptions {
  /** Validity window granted to an approved subject. */
  readonly validityMs?: number;
  readonly now?: () => Date;
}

/**
 * Deterministic development adapter. PERFORMS NO KYC, AML OR SANCTIONS SCREENING.
 *
 * A subject reference containing "blocked" is rejected; everything else is approved.
 */
export class MockComplianceProvider implements ComplianceProvider {
  readonly name = 'mock-local';

  private readonly validityMs: number;
  private readonly now: () => Date;
  private readonly forcedIneligible = new Set<string>();

  constructor(options: MockComplianceOptions = {}) {
    this.validityMs = options.validityMs ?? 365 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** Test hook: force a wallet to fail the pre-execution eligibility re-check. */
  forceIneligible(walletAddress: string): void {
    this.forcedIneligible.add(walletAddress.toLowerCase());
  }

  clearForcedIneligible(walletAddress: string): void {
    this.forcedIneligible.delete(walletAddress.toLowerCase());
  }

  private isBlocked(request: { subjectReference: string; walletAddress: string }): boolean {
    return (
      request.subjectReference.toLowerCase().includes('blocked') ||
      this.forcedIneligible.has(request.walletAddress.toLowerCase())
    );
  }

  private reference(request: ComplianceScreenRequest | ComplianceEligibilityRequest): string {
    const digest = createHash('sha256')
      .update(`${this.name}:${request.subjectReference}:${request.walletAddress}:${request.chainId}`)
      .digest('hex');
    return `mock-${digest.slice(0, 32)}`;
  }

  async screen(request: ComplianceScreenRequest): Promise<ComplianceDecisionResult> {
    const decidedAt = this.now();
    const blocked = this.isBlocked(request);

    return {
      status: blocked ? ComplianceStatus.REJECTED : ComplianceStatus.APPROVED,
      provider: this.name,
      providerReference: this.reference(request),
      validFrom: decidedAt,
      validUntil: new Date(decidedAt.getTime() + this.validityMs),
      decidedAt,
      ...(blocked ? { reason: 'subject reference is on the local mock deny list' } : {}),
    };
  }

  async checkEligibility(
    request: ComplianceEligibilityRequest,
  ): Promise<ComplianceEligibilityResult> {
    const blocked = this.isBlocked(request);
    return {
      eligible: !blocked,
      provider: this.name,
      providerReference: this.reference(request),
      checkedAt: this.now(),
      ...(blocked ? { reason: 'subject is not eligible at execution time' } : {}),
    };
  }
}
