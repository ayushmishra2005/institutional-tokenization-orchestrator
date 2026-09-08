import { InvalidStateTransitionError } from './errors.js';

export const ApprovalRequestState = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** The underlying financial intent changed, so collected approvals no longer apply. */
  SUPERSEDED: 'SUPERSEDED',
  CANCELLED: 'CANCELLED',
} as const;

export type ApprovalRequestState =
  (typeof ApprovalRequestState)[keyof typeof ApprovalRequestState];

export const APPROVAL_REQUEST_STATES = Object.values(ApprovalRequestState);

export const ApprovalDecisionKind = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;

export type ApprovalDecisionKind =
  (typeof ApprovalDecisionKind)[keyof typeof ApprovalDecisionKind];

/** Phase 1 policy: two distinct approvers must approve a mint. */
export const REQUIRED_MINT_APPROVALS = 2;

const ALLOWED_TRANSITIONS: Record<ApprovalRequestState, readonly ApprovalRequestState[]> = {
  PENDING: [
    ApprovalRequestState.APPROVED,
    ApprovalRequestState.REJECTED,
    ApprovalRequestState.SUPERSEDED,
    ApprovalRequestState.CANCELLED,
  ],
  APPROVED: [],
  REJECTED: [],
  SUPERSEDED: [],
  CANCELLED: [],
};

export function canTransitionApprovalRequest(
  from: ApprovalRequestState,
  to: ApprovalRequestState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertApprovalRequestTransition(
  from: ApprovalRequestState,
  to: ApprovalRequestState,
): void {
  if (!canTransitionApprovalRequest(from, to)) {
    throw new InvalidStateTransitionError('approval_request', from, to);
  }
}

export function isApprovalRequestOpen(state: ApprovalRequestState): boolean {
  return state === ApprovalRequestState.PENDING;
}

export interface ApprovalTallyInput {
  readonly requiredApprovals: number;
  readonly approverIds: readonly string[];
  readonly hasRejection: boolean;
}

export type ApprovalOutcome =
  | { readonly kind: 'PENDING'; readonly remaining: number }
  | { readonly kind: 'APPROVED' }
  | { readonly kind: 'REJECTED' };

/**
 * Pure tally over recorded decisions. Distinct approver identities are counted, so a
 * duplicated row for the same actor can never satisfy the threshold on its own.
 */
export function evaluateApprovalOutcome(input: ApprovalTallyInput): ApprovalOutcome {
  if (input.hasRejection) return { kind: 'REJECTED' };

  const distinctApprovers = new Set(input.approverIds).size;
  if (distinctApprovers >= input.requiredApprovals) return { kind: 'APPROVED' };

  return { kind: 'PENDING', remaining: input.requiredApprovals - distinctApprovers };
}
