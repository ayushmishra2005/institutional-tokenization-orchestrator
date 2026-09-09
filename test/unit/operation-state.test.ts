import { describe, expect, it } from 'vitest';
import {
  allowedOperationTransitions,
  assertOperationTransition,
  canTransitionOperation,
  isTerminalOperationState,
  OPERATION_STATES,
  OperationState,
} from '../../src/domain/operation-state.js';
import { InvalidStateTransitionError } from '../../src/domain/errors.js';

describe('operation state machine', () => {
  it('allows the happy path from request to success', () => {
    const path: OperationState[] = [
      OperationState.PENDING_APPROVAL,
      OperationState.READY,
      OperationState.PREPARING,
      OperationState.SIGNING,
      OperationState.SIGNED,
      OperationState.BROADCASTING,
      OperationState.SUBMITTED,
      OperationState.INCLUDED,
      OperationState.SUCCEEDED,
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index]!;
      const to = path[index + 1]!;
      expect(canTransitionOperation(from, to), `${from} -> ${to}`).toBe(true);
      expect(() => assertOperationTransition(from, to)).not.toThrow();
    }
  });

  it('rejects skipping the signing step', () => {
    expect(canTransitionOperation(OperationState.READY, OperationState.SIGNED)).toBe(false);
    expect(() =>
      assertOperationTransition(OperationState.READY, OperationState.SIGNED),
    ).toThrow(InvalidStateTransitionError);
  });

  it('rejects broadcasting before bytes are signed', () => {
    expect(canTransitionOperation(OperationState.PREPARING, OperationState.BROADCASTING)).toBe(
      false,
    );
    expect(canTransitionOperation(OperationState.SIGNING, OperationState.BROADCASTING)).toBe(false);
  });

  it('keeps SIGNED distinct from BROADCASTING and SUBMITTED', () => {
    expect(canTransitionOperation(OperationState.SIGNED, OperationState.SUBMITTED)).toBe(false);
    expect(canTransitionOperation(OperationState.SIGNED, OperationState.BROADCASTING)).toBe(true);
    expect(canTransitionOperation(OperationState.BROADCASTING, OperationState.SUBMITTED)).toBe(true);
  });

  it('keeps SUBMITTED distinct from INCLUDED and INCLUDED distinct from final', () => {
    expect(canTransitionOperation(OperationState.SUBMITTED, OperationState.SUCCEEDED)).toBe(false);
    expect(canTransitionOperation(OperationState.SUBMITTED, OperationState.INCLUDED)).toBe(true);
    expect(canTransitionOperation(OperationState.INCLUDED, OperationState.SUCCEEDED)).toBe(true);
  });

  it('never treats BROADCAST_UNKNOWN as an immediate success or revert', () => {
    expect(canTransitionOperation(OperationState.BROADCAST_UNKNOWN, OperationState.SUCCEEDED)).toBe(
      false,
    );
    expect(canTransitionOperation(OperationState.BROADCAST_UNKNOWN, OperationState.REVERTED)).toBe(
      false,
    );
  });

  it('allows BROADCAST_UNKNOWN to be resolved by rebroadcast or discovery', () => {
    const allowed = allowedOperationTransitions(OperationState.BROADCAST_UNKNOWN);
    expect(allowed).toContain(OperationState.BROADCASTING);
    expect(allowed).toContain(OperationState.SUBMITTED);
    expect(allowed).toContain(OperationState.INCLUDED);
  });

  it('does not allow SIGNED to jump straight to BROADCAST_UNKNOWN', () => {
    // Ambiguity only becomes possible once a broadcast has actually been attempted.
    expect(canTransitionOperation(OperationState.SIGNED, OperationState.BROADCAST_UNKNOWN)).toBe(
      false,
    );
  });

  it('treats terminal states as terminal', () => {
    for (const state of [
      OperationState.SUCCEEDED,
      OperationState.REVERTED,
      OperationState.FAILED,
      OperationState.CANCELLED,
    ]) {
      expect(isTerminalOperationState(state)).toBe(true);
      expect(allowedOperationTransitions(state)).toHaveLength(0);
      for (const target of OPERATION_STATES) {
        expect(canTransitionOperation(state, target), `${state} -> ${target}`).toBe(false);
      }
    }
  });

  it('cannot cancel an operation once it is executing', () => {
    for (const state of [
      OperationState.PREPARING,
      OperationState.SIGNING,
      OperationState.SIGNED,
      OperationState.BROADCASTING,
      OperationState.SUBMITTED,
      OperationState.INCLUDED,
    ]) {
      expect(canTransitionOperation(state, OperationState.CANCELLED), state).toBe(false);
    }
  });

  it('does not allow a submitted transaction to be failed outright', () => {
    expect(canTransitionOperation(OperationState.SUBMITTED, OperationState.FAILED)).toBe(false);
    expect(canTransitionOperation(OperationState.INCLUDED, OperationState.FAILED)).toBe(false);
  });

  it('reports the offending edge in the thrown error', () => {
    try {
      assertOperationTransition(OperationState.SUCCEEDED, OperationState.READY);
      expect.unreachable('expected a transition error');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionError);
      expect((error as InvalidStateTransitionError).details).toMatchObject({
        machine: 'operation',
        from: 'SUCCEEDED',
        to: 'READY',
      });
    }
  });

  it('permits cancellation only before a signature exists', () => {
    for (const state of [OperationState.PENDING_APPROVAL, OperationState.READY]) {
      expect(canTransitionOperation(state, OperationState.CANCELLED), state).toBe(true);
    }

    // Once bytes are signed the transaction may reach the chain at any moment, and no
    // application state change can retract it.
    for (const state of [
      OperationState.SIGNED,
      OperationState.BROADCASTING,
      OperationState.BROADCAST_UNKNOWN,
      OperationState.SUBMITTED,
      OperationState.INCLUDED,
      OperationState.SUCCEEDED,
    ]) {
      expect(canTransitionOperation(state, OperationState.CANCELLED), state).toBe(false);
    }
  });

  it('has no self-transitions', () => {
    for (const state of OPERATION_STATES) {
      expect(canTransitionOperation(state, state), state).toBe(false);
    }
  });
});
