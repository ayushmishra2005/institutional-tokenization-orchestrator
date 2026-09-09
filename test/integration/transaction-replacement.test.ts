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
import { DeferredSignerProvider } from '../../src/adapters/signer/deferred-signer-provider.js';
import { LocalSignerProvider } from '../../src/adapters/signer/local-signer-provider.js';
import { ViemEvmGateway } from '../../src/adapters/evm/viem-evm-gateway.js';
import { createMetrics } from '../../src/platform/metrics/index.js';
import { getConfig } from '../../src/platform/config/index.js';
import { OperationState } from '../../src/domain/operation-state.js';
import {
  findAttemptById,
  listAttemptsForOperation,
  readReservedNonce,
  type TransactionAttemptRecord,
} from '../../src/db/repositories/transaction-repository.js';
import { operations, transactionAttempts } from '../../src/db/schema/index.js';

/**
 * Replacement and nonce recovery both publish a transaction at a nonce that is already
 * reserved. These tests pin the two properties that make that safe: the intent may not
 * change, and the superseded bytes may never reach the chain afterwards.
 */
describe('same-nonce replacement and nonce-lane recovery', () => {
  let harness: TestHarness;
  let seed: SeededAsset;
  let gateway: FaultInjectingGateway;
  let signer: DeferredSignerProvider;
  let signerAddress: `0x${string}`;

  beforeAll(async () => {
    const config = getConfig();
    gateway = new FaultInjectingGateway(
      new ViemEvmGateway({
        rpcUrl: config.EVM_RPC_URL,
        chainId: config.EVM_CHAIN_ID,
        metrics: createMetrics(),
      }),
    );
    signer = new DeferredSignerProvider(
      new LocalSignerProvider({
        privateKey: config.LOCAL_SIGNER_PRIVATE_KEY as `0x${string}`,
        expectedAddress: config.LOCAL_SIGNER_ADDRESS as `0x${string}`,
        chainId: config.EVM_CHAIN_ID,
      }),
      { pollsBeforeSigning: 0 },
    );
    // One replacement is enough to prove the bound is enforced.
    harness = await createHarness({
      gateway,
      signer,
      config: { TRANSACTION_MAX_REPLACEMENTS: 1 },
    });
    seed = await seedAssetAndWallet(harness);
    signerAddress = await signer.getSignerAddress();
  }, 240_000);

  afterAll(async () => {
    await harness.close();
  });

  async function readyMint(amount: string): Promise<string> {
    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);
    return mint.operationId;
  }

  /** Ages an attempt so the chain profile considers it stuck, using database time. */
  async function ageAttempt(attemptId: string): Promise<void> {
    await harness.container.db
      .update(transactionAttempts)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(transactionAttempts.id, attemptId));
  }

  async function laneNonce(): Promise<number | null> {
    return readReservedNonce(harness.container.db, {
      chainId: harness.container.chainProfile.chainId,
      signerAddress,
    });
  }

  async function attemptsFor(operationId: string): Promise<TransactionAttemptRecord[]> {
    return listAttemptsForOperation(harness.container.db, operationId);
  }

  /**
   * The sweep is signer-wide and these suites share one database, so attempts abandoned by
   * other files can be eligible at the same time. Count only this operation's.
   */
  async function replaceStuck(operationId: string): Promise<number> {
    const before = (await attemptsFor(operationId)).length;
    await harness.container.replacement.replaceStuckTransactions();
    return (await attemptsFor(operationId)).length - before;
  }

  it('replaces a stuck transaction at the same nonce with a higher fee', async () => {
    // The bytes never reach a node, so nothing will ever be mined at this nonce until
    // something else is published for it.
    gateway.controls.broadcastPlan = ['ambiguous-before-send'];
    const operationId = await readyMint('4000000000000000000');
    await harness.container.operationExecutor.execute(operationId, 'worker-1');
    expect(await getOperationState(harness, operationId)).toBe(OperationState.BROADCAST_UNKNOWN);

    const [original] = await attemptsFor(operationId);
    await ageAttempt(original!.id);

    expect(await replaceStuck(operationId)).toBe(1);

    const attempts = await attemptsFor(operationId);
    expect(attempts).toHaveLength(2);
    const replacement = attempts.find((attempt) => attempt.id !== original!.id)!;
    const superseded = await findAttemptById(harness.container.db, original!.id);

    expect(replacement.nonce).toBe(original!.nonce);
    expect(replacement.replacesAttemptId).toBe(original!.id);
    expect(replacement.replacementNumber).toBe(1);
    expect(replacement.intentFingerprint).toBe(original!.intentFingerprint);
    expect(replacement.data).toBe(original!.data);
    expect(replacement.toAddress).toBe(original!.toAddress);
    expect(BigInt(replacement.maxFeePerGas)).toBeGreaterThan(BigInt(original!.maxFeePerGas));
    expect(BigInt(replacement.maxPriorityFeePerGas)).toBeGreaterThan(
      BigInt(original!.maxPriorityFeePerGas),
    );

    // The superseded attempt keeps its own hash and bytes: it is history, not a mistake.
    expect(superseded?.status).toBe('REPLACED');
    expect(superseded?.replacedByAttemptId).toBe(replacement.id);
    expect(superseded?.transactionHash).toBe(original!.transactionHash);
    expect(superseded?.replacementReason).toBe('STUCK_NO_INCLUSION');

    expect(await waitForState(harness, operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );
    const settled = await attemptsFor(operationId);
    expect(settled.filter((attempt) => attempt.status === 'CONFIRMED')).toHaveLength(1);
  }, 180_000);

  it('refuses to broadcast a superseded attempt', async () => {
    gateway.controls.broadcastPlan = ['ambiguous-before-send'];
    const operationId = await readyMint('5000000000000000000');
    await harness.container.operationExecutor.execute(operationId, 'worker-1');

    const [original] = await attemptsFor(operationId);
    await ageAttempt(original!.id);
    expect(await replaceStuck(operationId)).toBe(1);
    await waitForState(harness, operationId, isTerminal, 90_000);

    const superseded = await findAttemptById(harness.container.db, original!.id);
    const balanceBefore = await gateway.readBalanceOf(seed.contractAddress, seed.recipient);

    // A worker holding the old attempt tries to finish the job it was given.
    const outcome = await harness.container.chainWriter.broadcast(
      superseded!,
      superseded!.signedRawTransaction!,
      superseded!.transactionHash!,
    );

    expect(outcome).toMatchObject({ kind: 'FAILED', code: 'ATTEMPT_SUPERSEDED' });
    expect(await gateway.readBalanceOf(seed.contractAddress, seed.recipient)).toBe(balanceBefore);
  }, 180_000);

  it('clears a nonce held by a withheld transaction and leaves the lane usable', async () => {
    signer.holdNewRequestsFor(1);
    const operationId = await readyMint('7000000000000000000');
    await harness.container.operationExecutor.execute(operationId, 'worker-1');
    expect(await getOperationState(harness, operationId)).toBe(OperationState.SIGNING);

    const [withheld] = await attemptsFor(operationId);
    const revoked = await harness.app.inject({
      method: 'POST',
      url: `/v1/wallets/${seed.walletId}/compliance-revocations`,
      headers: harness.auth('dev-compliance'),
      payload: { assetId: seed.assetId, reason: 'sanctions hit while signing' },
    });
    expect(revoked.statusCode).toBe(202);

    // The signature arrives for an operation that may no longer execute: the bytes are
    // persisted as evidence and the nonce is left reserved but unusable.
    signer.release(withheld!.id);
    await harness.container.db
      .update(operations)
      .set({ stateUpdatedAt: sql`now() - interval '1 hour'` })
      .where(eq(operations.id, operationId));
    await harness.container.recovery.sweep();

    expect(await getOperationState(harness, operationId)).toBe(OperationState.FAILED);
    const blocked = await findAttemptById(harness.container.db, withheld!.id);
    expect(blocked?.status).toBe('FAILED');
    expect(blocked?.signedRawTransaction).not.toBeNull();
    expect(blocked?.blockNumber).toBeNull();

    const reserved = await laneNonce();
    const chainNonce = await gateway.getTransactionCount(signerAddress, 'latest');
    expect(chainNonce).toBeLessThan(reserved!);

    signer.holdNewRequestsFor(0);

    const supplyBefore = (await gateway.readTokenState(seed.contractAddress)).totalSupply;
    expect(await harness.container.replacement.recoverBlockedLane()).toBe(1);

    const recovery = await harness.container.db
      .select()
      .from(transactionAttempts)
      .where(eq(transactionAttempts.replacesAttemptId, withheld!.id));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]!.purpose).toBe('NONCE_RECOVERY');
    expect(recovery[0]!.nonce).toBe(blocked!.nonce);
    expect(recovery[0]!.toAddress).toBe(signerAddress.toLowerCase());
    expect(recovery[0]!.data).toBe('0x');
    expect(recovery[0]!.value).toBe('0');
    expect(recovery[0]!.receiptStatus).toBe(1);

    // Recovery consumes the nonce without moving any tokens.
    expect((await gateway.readTokenState(seed.contractAddress)).totalSupply).toBe(supplyBefore);
    expect((await findAttemptById(harness.container.db, withheld!.id))?.status).toBe('REPLACED');
    expect(await gateway.getTransactionCount(signerAddress, 'latest')).toBe(reserved);

    // The lane is usable again: a fresh approval and mint takes the next nonce and lands.
    const refreshed = await harness.app.inject({
      method: 'POST',
      url: `/v1/wallets/${seed.walletId}/compliance-decisions`,
      headers: harness.auth('dev-compliance'),
      payload: { assetId: seed.assetId },
    });
    expect(refreshed.statusCode).toBe(202);
    const sync = refreshed.json<{ eligibilityOperationId: string }>().eligibilityOperationId;
    await harness.container.operationExecutor.execute(sync, 'worker-1');
    await waitForState(harness, sync, isTerminal, 90_000);

    const nextFreeNonce = await laneNonce();
    const next = await readyMint('8000000000000000000');
    await harness.container.operationExecutor.execute(next, 'worker-1');
    expect(await waitForState(harness, next, isTerminal, 90_000)).toBe(OperationState.SUCCEEDED);
    const [nextAttempt] = await attemptsFor(next);
    // No gap: the next financial transaction takes the nonce straight after the recovery.
    expect(nextAttempt!.nonce).toBe(nextFreeNonce);
  }, 240_000);
  it('stops replacing once the configured limit is reached', async () => {
    // Neither the original nor its replacement reaches a node, so both stay eligible on
    // every ground except the replacement count.
    gateway.controls.broadcastPlan = ['ambiguous-before-send', 'ambiguous-before-send'];
    const operationId = await readyMint('6000000000000000000');
    await harness.container.operationExecutor.execute(operationId, 'worker-1');

    const [original] = await attemptsFor(operationId);
    await ageAttempt(original!.id);
    expect(await replaceStuck(operationId)).toBe(1);

    const replacement = (await attemptsFor(operationId)).find(
      (attempt) => attempt.id !== original!.id,
    )!;
    expect(replacement.replacementNumber).toBe(1);

    await ageAttempt(replacement.id);
    expect(await replaceStuck(operationId)).toBe(0);
    expect(await attemptsFor(operationId)).toHaveLength(2);

    await expect(
      harness.container.chainWriter.replaceFees(
        (await findAttemptById(harness.container.db, replacement.id))!,
        {
          fees: { maxFeePerGas: 10n ** 12n, maxPriorityFeePerGas: 10n ** 9n },
          reason: 'STUCK_NO_INCLUSION',
          correlationId: 'test',
        },
      ),
    ).rejects.toMatchObject({ code: 'REPLACEMENT_LIMIT_REACHED' });
  }, 180_000);
});
