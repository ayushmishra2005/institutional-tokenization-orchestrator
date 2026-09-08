/**
 * Only a deterministic mock adapter is implemented. Nothing behind this interface performs
 * real KYC, AML, sanctions or identity verification.
 */

export const ComplianceStatus = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;

export type ComplianceStatus = (typeof ComplianceStatus)[keyof typeof ComplianceStatus];

export interface ComplianceScreenRequest {
  /** Opaque investor handle owned by the operator. Not real-world identity data. */
  readonly subjectReference: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly assetId?: string;
}

export interface ComplianceDecisionResult {
  readonly status: ComplianceStatus;
  readonly provider: string;
  /** Provider-side identifier for the decision, stored for later audit. */
  readonly providerReference: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly decidedAt: Date;
  readonly reason?: string;
}

export interface ComplianceEligibilityRequest {
  readonly subjectReference: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly assetId?: string;
  readonly amount: string;
}

export interface ComplianceEligibilityResult {
  readonly eligible: boolean;
  readonly provider: string;
  readonly providerReference: string;
  readonly checkedAt: Date;
  readonly reason?: string;
}

export interface ComplianceProvider {
  readonly name: string;

  /** Produces a durable decision recorded in PostgreSQL. */
  screen(request: ComplianceScreenRequest): Promise<ComplianceDecisionResult>;

  /**
   * Fresh check performed immediately before monetary execution. The worker must call
   * this rather than trusting the decision snapshot captured at request time.
   */
  checkEligibility(request: ComplianceEligibilityRequest): Promise<ComplianceEligibilityResult>;
}
