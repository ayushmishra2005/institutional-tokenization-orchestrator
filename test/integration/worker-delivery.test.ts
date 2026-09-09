import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { outbox } from '../../src/db/schema/index.js';
import { listAttemptsForOperation } from '../../src/db/repositories/transaction-repository.js';
import {
  claimPendingOutbox,
  markOutboxDispatched,
} from '../../src/db/repositories/outbox-repository.js';
import { findOperationById } from '../../src/db/repositories/operation-repository.js';

/**
 * Redis is a delivery mechanism, not the workflow authority. These tests remove or
 * duplicate queue messages and require the outcome to stay correct.
 */
describe('worker delivery semantics', () => {
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

  it('mints once even when the same job is delivered repeatedly', async () => {
    const seed = await seedAssetAndWallet(harness);
    const amount = '2000000000000000000';

    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    // Pile on redundant deliveries of the same operation, with distinct job ids so
    // BullMQ cannot deduplicate them for us.
    for (let index = 0; index < 5; index += 1) {
      await harness.container.queue.add(
        'mint-operation',
        {
          operationId: mint.operationId,
          correlationId: `dup-${index}`,
          outboxId: `dup-${index}`,
        },
        { jobId: `dup-${mint.operationId}-${index}` },
      );
    }

    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.SUCCEEDED || value === OperationState.FAILED,
      90_000,
    );
    expect(state).toBe(OperationState.SUCCEEDED);

    // Exactly one transaction was ever prepared, so exactly one mint happened.
    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts).toHaveLength(1);

    const balance = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    expect(balance).toBe(BigInt(amount));
  });

  it('rejects a late duplicate delivery for an already settled operation', async () => {
    const seed = await seedAssetAndWallet(harness);
    const mint = await requestMint(harness, seed, '1000000000000000000');
    await approveTwice(harness, mint.approvalRequestId);
    await waitForState(harness, mint.operationId, (value) => value === OperationState.SUCCEEDED);

    // Replaying the job after settlement must be a no-op, not a second mint.
    const result = await harness.container.operationExecutor.execute(mint.operationId, 'replay-worker');
    expect(result.kind).toBe('SKIPPED');

    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts).toHaveLength(1);
    const operation = await findOperationById(harness.container.db, mint.operationId);
    expect(operation?.state).toBe(OperationState.SUCCEEDED);
  });

  it('recovers the mint from PostgreSQL when the queue message is lost', async () => {
    const seed = await seedAssetAndWallet(harness);
    const amount = '6000000000000000000';

    // Hold back dispatch so the approval commits without anything reaching Redis.
    await harness.container.dispatcher.stop();

    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    // Simulate a dispatcher that published and then lost the message: the outbox row is
    // marked dispatched, but Redis holds nothing. Only PostgreSQL still knows.
    const [row] = await harness.container.db
      .select()
      .from(outbox)
      .where(eq(outbox.aggregateId, mint.operationId));
    expect(row!.status).toBe('PENDING');
    const { claimToken } = await harness.container.db.transaction((tx) =>
      claimPendingOutbox(tx, { limit: 1 }),
    );
    await markOutboxDispatched(harness.container.db, { ids: [row!.id], claimToken });
    await harness.container.queue.obliterate({ force: true });
    expect(await harness.container.queue.getJobCounts()).toMatchObject({ waiting: 0, active: 0 });

    const operation = await findOperationById(harness.container.db, mint.operationId);
    expect(operation?.state).toBe(OperationState.READY);

    // The recovery sweep must rebuild the lost job from durable state alone.
    harness.container.dispatcher.start();
    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.SUCCEEDED || value === OperationState.FAILED,
      90_000,
    );
    expect(state).toBe(OperationState.SUCCEEDED);

    const balance = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    expect(balance).toBe(BigInt(amount));
  });

  it('keeps the outbox row as the durable record of asynchronous intent', async () => {
    const seed = await seedAssetAndWallet(harness);
    const mint = await requestMint(harness, seed, '1000000000000000000');
    await approveTwice(harness, mint.approvalRequestId);
    await waitForState(harness, mint.operationId, (value) => value === OperationState.SUCCEEDED);

    const [row] = await harness.container.db
      .select()
      .from(outbox)
      .where(eq(outbox.aggregateId, mint.operationId));

    expect(row!.status).toBe('DISPATCHED');
    expect(row!.dispatchedAt).not.toBeNull();
    // The payload carries identifiers only: no amount, recipient or approval evidence.
    expect(JSON.stringify(row!.payload)).not.toMatch(/1000000000000000000/);
  });
});