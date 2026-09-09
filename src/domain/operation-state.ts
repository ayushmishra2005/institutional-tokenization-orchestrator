import { InvalidStateTransitionError } from './errors.js';

/**
 * Lifecycle of a financial operation (Phase 1: mint only).
 *
 * The distinctions below are load-bearing and must not be collapsed:
 *
 *   SIGNED            bytes exist and are durably persisted; nothing was sent
 *   BROADCASTING      we are about to hand the exact persisted bytes to an RPC node
 *   SUBMITTED         a node acknowledged the transaction hash
 *   INCLUDED          a receipt exists in a canonical block, but is not yet final
 *   SUCCEEDED         receipt succeeded, expected event validated, finality policy met
 *   BROADCAST_UNKNOWN we may or may not have published a valid transaction
 *
 * BROADCAST_UNKNOWN is explicitly NOT a failure. Treating it as one would allow a
 * second mint for money that may already be on chain.
 */
export const OperationState = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  READY: 'READY',
  PREPARING: 'PREPARING',
  SIGNING: 'SIGNING',
  SIGNED: 'SIGNED',
  BROADCASTING: 'BROADCASTING',
  BROADCAST_UNKNOWN: 'BROADCAST_UNKNOWN',
  SUBMITTED: 'SUBMITTED',
  INCLUDED: 'INCLUDED',
  SUCCEEDED: 'SUCCEEDED',
  REVERTED: 'REVERTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type OperationState = (typeof OperationState)[keyof typeof OperationState];

export const OPERATION_STATES = Object.values(OperationState);

export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  OperationState.SUCCEEDED,
  OperationState.REVERTED,
  OperationState.FAILED,
  OperationState.CANCELLED,
];

/**
 * States in which the operation may have an in-flight transaction carrying value.
 * A recovery sweep must resolve these against the chain rather than failing them.
 */
export const CHAIN_INFLIGHT_STATES: readonly OperationState[] = [
  OperationState.BROADCASTING,
  OperationState.BROADCAST_UNKNOWN,
  OperationState.SUBMITTED,
  OperationState.INCLUDED,
];

const ALLOWED_TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  PENDING_APPROVAL: [OperationState.READY, OperationState.CANCELLED, OperationState.FAILED],
  READY: [OperationState.PREPARING, OperationState.CANCELLED, OperationState.FAILED],
  // PREPARING may fall back to READY when a worker releases the claim before signing;
  // nothing has been signed yet, so no value is at risk.
  PREPARING: [OperationState.SIGNING, OperationState.READY, OperationState.FAILED],
  SIGNING: [OperationState.SIGNED, OperationState.FAILED],
  SIGNED: [OperationState.BROADCASTING, OperationState.FAILED],
  // Only a deterministic node-level rejection (the transaction was never accepted and
  // cannot be) may go to FAILED. Any timeout or transport fault goes to BROADCAST_UNKNOWN.
  BROADCASTING: [
    OperationState.SUBMITTED,
    OperationState.BROADCAST_UNKNOWN,
    OperationState.FAILED,
  ],
  // Recovery may re-send the identical persisted bytes, discover the receipt directly,
  // or - only once the chain proves the nonce was consumed by a different transaction -
  // conclude failure.
  BROADCAST_UNKNOWN: [
    OperationState.BROADCASTING,
    OperationState.SUBMITTED,
    OperationState.INCLUDED,
    OperationState.FAILED,
  ],
  // SUBMITTED -> BROADCAST_UNKNOWN covers a transaction dropped from the mempool.
  SUBMITTED: [OperationState.INCLUDED, OperationState.BROADCAST_UNKNOWN],
  // INCLUDED -> SUBMITTED is the reorg edge: the block carrying the receipt left the
  // canonical chain before finality, so inclusion is no longer an observed fact. The
  // transaction itself is unchanged and may still be mined.
  INCLUDED: [OperationState.SUCCEEDED, OperationState.REVERTED, OperationState.SUBMITTED],
  SUCCEEDED: [],
  REVERTED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTerminalOperationState(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(state);
}

export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedOperationTransitions(from: OperationState): readonly OperationState[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Pure guard. Throws {@link InvalidStateTransitionError} for any edge not in the machine. */
export function assertOperationTransition(from: OperationState, to: OperationState): void {
  if (!canTransitionOperation(from, to)) {
    throw new InvalidStateTransitionError('operation', from, to);
  }
}

export function isOperationState(value: string): value is OperationState {
  return (OPERATION_STATES as readonly string[]).includes(value);
}
