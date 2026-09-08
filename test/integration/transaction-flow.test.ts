import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  approveTwice,
  createHarness,
  requestMint,
  seedAssetAndWallet,
  testConfig,
  waitForState,
  type TestHarness,
} from './helpers.js';
import { FaultInjectingGateway } from './fault-gateway.js';
import { ViemEvmGateway } from '../../src/adapters/evm/viem-evm-gateway.js';
import { MockComplianceProvider } from '../../src/adapters/compliance/mock-compliance-provider.js';
import { startWorkerRuntime, type WorkerRuntime } from '../../src/worker/runtime.js';
import { OperationState } from '../../src/domain/operation-state.js';
import { transactionAttempts } from '../../src/db/schema/index.js';
import { listAttemptsForOperation } from '../../src/db/repositories/transaction-repository.js';

/**
 * Transport-fault behaviour of the transaction lane. Broadcast is intercepted so the
 * ambiguous-acknowledgement paths can be exercised deterministically, while every
 * assertion is still made against real Anvil state.
 */
describe('transaction flow under transport faults', () => {
  let harness: TestHarness;
  let gateway: FaultInjectingGateway;
  let compliance: MockComplianceProvider;
  let runtime: WorkerRuntime;

  beforeAll(async () => {
    const config = testConfig();
    gateway = new FaultInjectingGateway(
      new ViemEvmGateway({ rpcUrl: config.EVM_RPC_URL, chainId: config.EVM_CHAIN_ID }),
    );
    compliance = new MockComplianceProvider();
    harness = await createHarness({ gateway, complianceProvider: compliance });
    runtime = startWorkerRuntime(harness.container);
  });

  afterAll(async () => {
    await runtime.stop();
    await harness.close();
  });

  beforeEach(() => {
    gateway.reset();
  });

  it('recovers a lost acknowledgement by finding the transaction already on chain', async () => {
    const seed = await seedAssetAndWallet(harness);
    const amount = '5000000000000000000';
    // Deployment and eligibility sync already broadcast; only count what follows.
    const mintBroadcasts = gateway.broadcasts.length;

    // The transaction reaches the chain but the RPC response is lost.
    gateway.controls.broadcastPlan = ['ambiguous-after-send'];

    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.SUCCEEDED || value === OperationState.FAILED,
      90_000,
    );
    expect(state).toBe(OperationState.SUCCEEDED);

    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    // No second attempt: the recovery sweep resolved the original one by hash.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('CONFIRMED');

    // The mint happened exactly once, and only one set of bytes was ever produced.
    const balance = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    expect(balance).toBe(BigInt(amount));
    expect(distinctMintBytes(gateway, mintBroadcasts)).toBe(1);
  });

  it('rebroadcasts the identical signed bytes when nothing reached the chain', async () => {
    const seed = await seedAssetAndWallet(harness);
    const amount = '7000000000000000000';
    const mintBroadcasts = gateway.broadcasts.length;

    // The first broadcast is dropped entirely, so recovery must resend the same bytes.
    gateway.controls.broadcastPlan = ['ambiguous-before-send'];

    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    // The operation must pass through BROADCAST_UNKNOWN, never FAILED.
    const observed = new Set<string>();
    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => {
        observed.add(value);
        return value === OperationState.SUCCEEDED || value === OperationState.FAILED;
      },
      90_000,
    );
    expect(state).toBe(OperationState.SUCCEEDED);
    expect(observed).not.toContain(OperationState.FAILED);

    expect(gateway.broadcasts.length - mintBroadcasts).toBeGreaterThanOrEqual(2);
    // Byte-for-byte identical rebroadcast: no re-signing, no new nonce.
    expect(distinctMintBytes(gateway, mintBroadcasts)).toBe(1);

    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('CONFIRMED');

    const balance = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    expect(balance).toBe(BigInt(amount));
  });

  it('survives repeated ambiguous broadcasts without minting twice', async () => {
    const seed = await seedAssetAndWallet(harness);
    const amount = '3000000000000000000';
    const mintBroadcasts = gateway.broadcasts.length;

    gateway.controls.broadcastPlan = [
      'ambiguous-before-send',
      'ambiguous-before-send',
      'ambiguous-before-send',
    ];

    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);

    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.SUCCEEDED || value === OperationState.FAILED,
      120_000,
    );
    expect(state).toBe(OperationState.SUCCEEDED);

    const balance = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    expect(balance).toBe(BigInt(amount));
    expect(distinctMintBytes(gateway, mintBroadcasts)).toBe(1);
  });

  it('records REVERTED, not FAILED, when a mint reverts on chain', async () => {
    // The contract is given a short eligibility window while the durable compliance
    // decision keeps its full validity. Once the window lapses the application still
    // believes the recipient is eligible, but the chain - the actual authority - refuses.
    gateway.controls.eligibilityWindowSeconds = 5;
    const seed = await seedAssetAndWallet(harness);
    delete gateway.controls.eligibilityWindowSeconds;

    const eligibleUntil = await harness.container.gateway.readEligibleUntil(
      seed.contractAddress,
      seed.recipient,
    );
    expect(eligibleUntil).toBeGreaterThan(0n);
    await waitUntilAfter(eligibleUntil);

    // Simulation would catch this, so it is bypassed to reach a real on-chain revert.
    gateway.controls.forceSimulationSuccess = true;

    const mint = await requestMint(harness, seed, '1000000000000000000');
    await approveTwice(harness, mint.approvalRequestId);

    const state = await waitForState(
      harness,
      mint.operationId,
      (value) =>
        value === OperationState.REVERTED ||
        value === OperationState.SUCCEEDED ||
        value === OperationState.FAILED,
      90_000,
    );
    expect(state).toBe(OperationState.REVERTED);

    const [attempt] = await harness.container.db
      .select()
      .from(transactionAttempts)
      .where(eq(transactionAttempts.operationId, mint.operationId));
    expect(attempt!.status).toBe('REVERTED');

    // Nothing was minted and the reference is still unconsumed on chain.
    const balance = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    expect(balance).toBe(0n);

    const operation = (
      await harness.app.inject({
        method: 'GET',
        url: `/v1/operations/${mint.operationId}`,
        headers: harness.auth('dev-issuer'),
      })
    ).json<{ operationReference: string }>();
    const consumed = await harness.container.gateway.readReferenceConsumed(
      seed.contractAddress,
      operation.operationReference as `0x${string}`,
    );
    expect(consumed).toBe(false);
  });

  it('fails the operation before signing when the pre-flight compliance check fails', async () => {
    const seed = await seedAssetAndWallet(harness);
    const mint = await requestMint(harness, seed, '1000000000000000000');

    // The provider turns the subject down after the request was approved. The worker's
    // fresh re-check must catch it rather than trusting the approval snapshot.
    compliance.forceIneligible(seed.recipient);
    await approveTwice(harness, mint.approvalRequestId);

    const state = await waitForState(
      harness,
      mint.operationId,
      (value) => value === OperationState.FAILED || value === OperationState.SUCCEEDED,
      60_000,
    );
    expect(state).toBe(OperationState.FAILED);
    compliance.clearForcedIneligible(seed.recipient);

    // No signing or broadcast happened at all.
    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts.filter((attempt) => attempt.signedRawTransaction !== null)).toHaveLength(0);
  });
});

/** Number of distinct payloads broadcast after `from`, i.e. by the mint under test. */
function distinctMintBytes(gateway: FaultInjectingGateway, from: number): number {
  return new Set(gateway.broadcasts.slice(from).map((call) => call.signed)).size;
}

/** Sleeps until the wall clock is safely past an on-chain unix deadline. */
async function waitUntilAfter(unixSeconds: bigint): Promise<void> {
  const targetMs = Number(unixSeconds) * 1000 + 2000;
  const remaining = targetMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
