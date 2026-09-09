import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveTwice,
  createHarness,
  getOperationState,
  isTerminal,
  requestMint,
  seedAssetAndWallet,
  waitForState,
  type SeededAsset,
  type TestHarness,
} from './helpers.js';
import { FaultInjectingGateway } from './fault-gateway.js';
import { ViemEvmGateway } from '../../src/adapters/evm/viem-evm-gateway.js';
import { createMetrics } from '../../src/platform/metrics/index.js';
import { getConfig } from '../../src/platform/config/index.js';
import { OperationState } from '../../src/domain/operation-state.js';
import {
  listAttemptsForOperation,
  listObservations,
} from '../../src/db/repositories/transaction-repository.js';
import { auditEvents, operations } from '../../src/db/schema/index.js';

const MINT_AMOUNT = '1000000000000000000';

/**
 * A receipt proves inclusion in one block, not that the block survives. These tests drive
 * the orchestrator through a pre-finality reorg by answering canonicality lookups the way
 * a reorganised chain would.
 */
describe('finality and reorg handling', () => {
  let harness: TestHarness;
  let seed: SeededAsset;
  let gateway: FaultInjectingGateway;

  beforeAll(async () => {
    const config = getConfig();
    gateway = new FaultInjectingGateway(
      new ViemEvmGateway({
        rpcUrl: config.EVM_RPC_URL,
        chainId: config.EVM_CHAIN_ID,
        metrics: createMetrics(),
      }),
    );
    harness = await createHarness({ gateway });
    seed = await seedAssetAndWallet(harness);
  }, 240_000);

  afterAll(async () => {
    gateway.reset();
    await harness.close();
  });

  /** Treats the blocks the next transaction can land in as replaced. */
  async function orphanUpcomingBlocks(): Promise<void> {
    const from = await gateway.getLatestBlockNumber();
    for (let height = from; height <= from + 60; height += 1) {
      gateway.controls.orphanedBlocks.add(height);
    }
  }

  async function readyMint(): Promise<string> {
    const mint = await requestMint(harness, seed, MINT_AMOUNT);
    await approveTwice(harness, mint.approvalRequestId);
    return mint.operationId;
  }

  async function sweepStale(operationId: string): Promise<void> {
    await harness.container.db
      .update(operations)
      .set({ stateUpdatedAt: sql`now() - interval '1 hour'` })
      .where(eq(operations.id, operationId));
    await harness.container.recovery.sweep();
  }

  async function auditActions(operationId: string): Promise<string[]> {
    const rows = await harness.container.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId));
    return rows.map((row) => row.action);
  }

  it('keeps observing a mint whose block is orphaned, then finalizes it once the chain settles', async () => {
    const operationId = await readyMint();
    await orphanUpcomingBlocks();

    const balanceBefore = await gateway.readBalanceOf(seed.contractAddress, seed.recipient);
    await harness.container.operationExecutor.execute(operationId, 'worker-1');

    // Neither SUCCEEDED nor FAILED would be truthful: the transaction is real, its block
    // is not.
    expect(await getOperationState(harness, operationId)).toBe(OperationState.SUBMITTED);
    expect(await auditActions(operationId)).toContain('operation.reorg_observed');

    const [attempt] = await listAttemptsForOperation(harness.container.db, operationId);
    expect(attempt!.blockNumber).toBeNull();

    const orphanFindings = (await listObservations(harness.container.db, operationId)).filter(
      (observation) => observation.kind === 'BLOCK_CANONICALITY',
    );
    expect(orphanFindings).toHaveLength(1);
    expect(orphanFindings[0]).toMatchObject({ canonical: false, matched: false });
    expect(orphanFindings[0]!.blockHash).not.toBeNull();

    gateway.controls.orphanedBlocks.clear();
    await sweepStale(operationId);

    expect(await waitForState(harness, operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );
    // The same transaction was mined once: no second nonce, no second mint.
    const settled = await listAttemptsForOperation(harness.container.db, operationId);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.nonce).toBe(attempt!.nonce);
    expect(settled[0]!.transactionHash).toBe(attempt!.transactionHash);
    expect(await gateway.readBalanceOf(seed.contractAddress, seed.recipient)).toBe(
      balanceBefore + BigInt(MINT_AMOUNT),
    );
  }, 240_000);

  it('does not rewind a finalized operation when reconciliation runs again', async () => {
    gateway.controls.orphanedBlocks.clear();
    const operationId = await readyMint();
    await harness.container.operationExecutor.execute(operationId, 'worker-1');
    expect(await waitForState(harness, operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );

    const [attempt] = await listAttemptsForOperation(harness.container.db, operationId);
    const balanceAfter = await gateway.readBalanceOf(seed.contractAddress, seed.recipient);
    gateway.controls.orphanedBlocks.add(attempt!.blockNumber!);

    await harness.container.operationExecutor.observeAndFinalize({
      operationId,
      attemptId: attempt!.id,
      transactionHash: attempt!.transactionHash as `0x${string}`,
      log: harness.container.logger,
    });

    expect(await getOperationState(harness, operationId)).toBe(OperationState.SUCCEEDED);
    expect(await listAttemptsForOperation(harness.container.db, operationId)).toHaveLength(1);
    expect(await auditActions(operationId)).not.toContain('operation.reorg_observed');
    expect(await gateway.readBalanceOf(seed.contractAddress, seed.recipient)).toBe(balanceAfter);
    gateway.controls.orphanedBlocks.clear();
  }, 240_000);
});
