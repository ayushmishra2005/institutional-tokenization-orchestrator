import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  approveTwice,
  createHarness,
  requestMint,
  seedAssetAndWallet,
  testConfig,
  waitForState,
  type SeededAsset,
  type TestHarness,
} from './helpers.js';
import { FaultInjectingGateway } from './fault-gateway.js';
import { ViemEvmGateway } from '../../src/adapters/evm/viem-evm-gateway.js';
import { startWorkerRuntime, type WorkerRuntime } from '../../src/worker/runtime.js';
import { OperationState } from '../../src/domain/operation-state.js';
import { operations, outbox } from '../../src/db/schema/index.js';
import {
  findOperationById,
  lockOperation,
  transitionOperation,
} from '../../src/db/repositories/operation-repository.js';
import {
  insertPreparedAttempt,
  listAttemptsForOperation,
  readReservedNonce,
  reserveNonce,
} from '../../src/db/repositories/transaction-repository.js';

/**
 * Every boundary at which a worker or the queue can die between a durable commit and the
 * next one. In all of them the mint must still happen exactly once, or not at all, and
 * the operation must never be left stranded in a non-terminal state.
 */
describe('crash recovery', () => {
  let harness: TestHarness;
  let gateway: FaultInjectingGateway;
  let runtime: WorkerRuntime;
  let seed: SeededAsset;

  beforeAll(async () => {
    const config = testConfig();
    gateway = new FaultInjectingGateway(
      new ViemEvmGateway({ rpcUrl: config.EVM_RPC_URL, chainId: config.EVM_CHAIN_ID }),
    );
    harness = await createHarness({
      gateway,
      // Short timeouts keep the sweep-driven paths quick without arbitrary sleeps.
      config: { EVM_RECEIPT_TIMEOUT_MS: 3000, RECOVERY_STALE_AFTER_MS: 500 },
    });
    runtime = startWorkerRuntime(harness.container);
    seed = await seedAssetAndWallet(harness);
  });

  afterEach(() => {
    gateway.reset();
  });

  afterAll(async () => {
    await runtime.stop();
    await harness.close();
  });

  it('recreates delivery when business state committed but the outbox never dispatched', async () => {
    await harness.container.dispatcher.stop();

    const amount = '1100000000000000000';
    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    const [row] = await harness.container.db
      .select()
      .from(outbox)
      .where(eq(outbox.aggregateId, mint.operationId));
    expect(row!.status).toBe('PENDING');
    expect(await harness.container.queue.getJobCounts()).toMatchObject({ waiting: 0, active: 0 });

    harness.container.dispatcher.start();
    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.SUCCEEDED || value === OperationState.FAILED,
      90_000,
    );
    expect(state).toBe(OperationState.SUCCEEDED);
    expect(await balanceOf(harness, seed)).toBeGreaterThanOrEqual(BigInt(amount));
  });

  it('finalizes from the persisted hash when the receipt lookup dies mid-confirmation', async () => {
    const amount = '1400000000000000000';
    const mint = await requestMint(harness, seed, amount);

    // Enough failures to exhaust the confirmation window, so the worker gives up after
    // broadcasting. The transaction is genuinely on chain and the hash is persisted.
    gateway.controls.failReceiptLookups = 500;
    await approveTwice(harness, mint.approvalRequestId);

    const submitted = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.SUBMITTED || isSettled(value),
      90_000,
    );
    expect(submitted).toBe(OperationState.SUBMITTED);

    // The RPC endpoint recovers; the sweep must now advance the operation using only the
    // transaction hash it already holds.
    gateway.controls.failReceiptLookups = 0;
    await markStale(harness, mint.operationId);

    const state = await waitForState(harness, mint.operationId, isSettled, 90_000);
    expect(state).toBe(OperationState.SUCCEEDED);

    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('CONFIRMED');
  });

  it('reconstructs the work from PostgreSQL after Redis is flushed entirely', async () => {
    await harness.container.dispatcher.stop();

    const amount = '1500000000000000000';
    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    const balanceBefore = await balanceOf(harness, seed);

    // Destroy every trace of the queue, including retained job state.
    await harness.container.queue.obliterate({ force: true });
    await harness.container.redis.flushdb();
    expect(await harness.container.queue.getJobCounts()).toMatchObject({ waiting: 0, active: 0 });

    // The financial intent survived, because it never lived in Redis.
    const durable = await findOperationById(harness.container.db, mint.operationId);
    expect(durable?.state).toBe(OperationState.READY);
    expect(durable?.amount).toBe(amount);

    harness.container.dispatcher.start();
    const state = await waitForState(harness, mint.operationId, isSettled, 90_000);
    expect(state).toBe(OperationState.SUCCEEDED);

    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts).toHaveLength(1);
    expect(await balanceOf(harness, seed)).toBe(balanceBefore + BigInt(amount));
  });
  it('fails an operation abandoned after nonce reservation without reusing the lane', async () => {
    // Rebuild the exact durable state a worker leaves behind when it dies between
    // reserving a nonce and asking the signer for bytes.
    const stranded = await requestMint(harness, seed, '1300000000000000000');
    await harness.container.dispatcher.stop();
    await approveTwice(harness, stranded.approvalRequestId);

    // A dedicated lane: this nonce is deliberately never broadcast, and a gap in the real
    // signer's lane would stall every later transaction on the shared node.
    const signerAddress = '0x00000000000000000000000000000000000000de' as const;
    const chainId = harness.container.config.EVM_CHAIN_ID;
    const nonceBefore = await readReservedNonce(harness.container.db, { chainId, signerAddress });

    await harness.container.db.transaction(async (tx) => {
      const operation = await lockOperation(tx, stranded.operationId);
      const preparing = await transitionOperation(tx, {
        operation: operation!,
        to: OperationState.PREPARING,
        patch: { claimedBy: 'dead-worker', claimedAt: new Date() },
      });
      const nonce = await reserveNonce(tx, {
        chainId,
        signerAddress,
        chainNonce: 0,
      });
      await insertPreparedAttempt(tx, {
        operationId: preparing.id,
        assetId: preparing.assetId,
        walletId: preparing.walletId,
        purpose: 'MINT',
        chainId,
        fromAddress: signerAddress,
        toAddress: seed.contractAddress,
        nonce,
        data: '0x00',
        gasLimit: 500_000,
        maxFeePerGas: '1000000000',
        maxPriorityFeePerGas: '1000000',
        requestHash: 'a'.repeat(64),
        intentFingerprint: 'b'.repeat(64),
      });
    });

    await markStale(harness, stranded.operationId);
    const summary = await harness.container.recovery.sweep();
    expect(summary.failed).toBeGreaterThanOrEqual(1);

    // Nothing was signed, so nothing can be on chain: failing is safe and it is the only
    // truthful outcome. What must never happen is a second nonce for the same intent.
    const operation = await findOperationById(harness.container.db, stranded.operationId);
    expect(operation?.state).toBe(OperationState.FAILED);
    expect(operation?.failureCode).toBe('ABANDONED_BEFORE_BROADCAST');

    const attempts = await listAttemptsForOperation(harness.container.db, stranded.operationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('FAILED');

    const nonceAfter = await readReservedNonce(harness.container.db, { chainId, signerAddress });
    expect(nonceAfter).toBe((nonceBefore ?? 0) + 1);

    harness.container.dispatcher.start();
  });
});

const isSettled = (state: string): boolean =>
  state === OperationState.SUCCEEDED ||
  state === OperationState.REVERTED ||
  state === OperationState.FAILED ||
  state === OperationState.CANCELLED;

function balanceOf(harness: TestHarness, seed: SeededAsset): Promise<bigint> {
  return harness.container.gateway.readBalanceOf(seed.contractAddress, seed.recipient);
}

/** Ages an operation past the recovery threshold without sleeping for it. */
async function markStale(harness: TestHarness, operationId: string): Promise<void> {
  await harness.container.db
    .update(operations)
    .set({ stateUpdatedAt: sql`now() - interval '1 hour'` })
    .where(eq(operations.id, operationId));
}
