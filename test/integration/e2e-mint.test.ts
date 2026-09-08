import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveTwice,
  createHarness,
  requestMint,
  seedAssetAndWallet,
  waitForState,
  type TestHarness,
} from './helpers.js';
import { startWorkerRuntime, type WorkerRuntime } from '../../src/worker/runtime.js';
import { OperationState } from '../../src/domain/operation-state.js';
import { listAuditEvents } from '../../src/db/repositories/audit-repository.js';

/**
 * The full vertical slice against real PostgreSQL, Redis and Anvil:
 * API -> approvals -> outbox -> BullMQ worker -> signer -> chain -> reconciliation.
 */
describe('end-to-end mint', () => {
  let harness: TestHarness;
  let runtime: WorkerRuntime;

  beforeAll(async () => {
    harness = await createHarness();
    runtime = startWorkerRuntime(harness.container);
  });

  afterAll(async () => {
    await runtime.stop();
    await harness.close();
  });

  it('carries an approved mint through to SUCCEEDED and reconciles against the chain', async () => {
    const seed = await seedAssetAndWallet(harness);
    const amount = '4200000000000000000000';

    const mint = await requestMint(harness, seed, amount);
    expect(await waitForState(harness, mint.operationId, (state) => state !== '')).toBe(
      OperationState.PENDING_APPROVAL,
    );

    await approveTwice(harness, mint.approvalRequestId);

    const finalState = await waitForState(
      harness,
      mint.operationId,
      (state) => state === OperationState.SUCCEEDED || state === OperationState.FAILED,
    );
    expect(finalState).toBe(OperationState.SUCCEEDED);

    const operation = (
      await harness.app.inject({
        method: 'GET',
        url: `/v1/operations/${mint.operationId}`,
        headers: harness.auth('dev-issuer'),
      })
    ).json<{
      state: string;
      operationReference: string;
      history: { state: string; at: string }[];
      transactionAttempts: { status: string; transactionHash: string | null; nonce: number }[];
      reconciliation: { kind: string; matched: boolean }[];
    }>();

    expect(operation.history.map((entry) => entry.state)).toEqual([
      OperationState.PENDING_APPROVAL,
      OperationState.READY,
      OperationState.PREPARING,
      OperationState.SIGNING,
      OperationState.SIGNED,
      OperationState.BROADCASTING,
      OperationState.SUBMITTED,
      OperationState.INCLUDED,
      OperationState.SUCCEEDED,
    ]);

    expect(operation.reconciliation.length).toBeGreaterThanOrEqual(5);
    expect(operation.reconciliation.every((entry) => entry.matched)).toBe(true);
    expect(operation.reconciliation.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'RECEIPT',
        'MINT_EVENT',
        'REFERENCE_CONSUMED',
        'RECIPIENT_BALANCE',
        'TOTAL_SUPPLY',
      ]),
    );

    const attempt = operation.transactionAttempts.at(-1);
    expect(attempt?.status).toBe('CONFIRMED');
    expect(attempt?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Canonical chain state agrees with PostgreSQL.
    const balance = await harness.container.gateway.readBalanceOf(seed.contractAddress, seed.recipient);
    expect(balance).toBe(BigInt(amount));
    const consumed = await harness.container.gateway.readReferenceConsumed(
      seed.contractAddress,
      operation.operationReference as `0x${string}`,
    );
    expect(consumed).toBe(true);
  });

  it('never exposes signed transaction bytes through the API', async () => {
    const seed = await seedAssetAndWallet(harness);
    const mint = await requestMint(harness, seed, '1000000000000000000');
    await approveTwice(harness, mint.approvalRequestId);
    await waitForState(harness, mint.operationId, (state) => state === OperationState.SUCCEEDED);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/operations/${mint.operationId}`,
      headers: harness.auth('dev-issuer'),
    });
    expect(response.body).not.toMatch(/signedRawTransaction|signed_raw_transaction/);
    // A signed EIP-1559 payload would appear as a long 0x02-prefixed blob.
    expect(response.body).not.toMatch(/0x02[0-9a-f]{100,}/);
  });

  it('writes audit evidence for every privileged transition', async () => {
    const seed = await seedAssetAndWallet(harness);
    const mint = await requestMint(harness, seed, '1000000000000000000');
    await approveTwice(harness, mint.approvalRequestId);
    await waitForState(harness, mint.operationId, (state) => state === OperationState.SUCCEEDED);

    const events = await listAuditEvents(harness.container.db, {
      operationId: mint.operationId,
      limit: 100,
    });
    const actions = events.map((event) => event.action);

    expect(actions).toEqual(
      expect.arrayContaining([
        'operation.mint_requested',
        'approval.decision_recorded',
        'operation.approved',
        'operation.succeeded',
      ]),
    );
    expect(actions.filter((action) => action === 'approval.decision_recorded')).toHaveLength(2);
    expect(events.every((event) => event.correlationId.length > 0)).toBe(true);
  });

  it('exposes the audit trail to an auditor and denies it to an issuer', async () => {
    const allowed = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit-events?limit=5',
      headers: harness.auth('dev-auditor'),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ events: unknown[] }>().events.length).toBeGreaterThan(0);

    const denied = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit-events',
      headers: harness.auth('dev-issuer'),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
  });

  it('scopes API readiness to PostgreSQL, the only dependency it needs synchronously', async () => {
    const live = await harness.app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);

    const ready = await harness.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    const { checks } = ready.json<{ checks: Record<string, string> }>();
    expect(checks).toEqual({ postgres: 'ok' });

    const metrics = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('ito_operation_transitions_total');
    expect(metrics.body).toContain('ito_http_requests_total');
  });
});
