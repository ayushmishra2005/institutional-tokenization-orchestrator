import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { DeferredSignerProvider } from '../../src/adapters/signer/deferred-signer-provider.js';
import { LocalSignerProvider } from '../../src/adapters/signer/local-signer-provider.js';
import { getConfig } from '../../src/platform/config/index.js';
import { OperationState } from '../../src/domain/operation-state.js';
import { listAttemptsForOperation } from '../../src/db/repositories/transaction-repository.js';
import { findSignerRequestForAttempt } from '../../src/db/repositories/signer-request-repository.js';
import { operations } from '../../src/db/schema/index.js';

/**
 * The signer here answers only when polled, which is how an institutional custody
 * provider behaves: the worker that asked for a signature is usually not the one that
 * receives it.
 */
describe('asynchronous signer', () => {
  let harness: TestHarness;
  let seed: SeededAsset;
  let signer: DeferredSignerProvider;

  beforeAll(async () => {
    const config = getConfig();
    signer = new DeferredSignerProvider(
      new LocalSignerProvider({
        privateKey: config.LOCAL_SIGNER_PRIVATE_KEY as `0x${string}`,
        expectedAddress: config.LOCAL_SIGNER_ADDRESS as `0x${string}`,
        chainId: config.EVM_CHAIN_ID,
      }),
      // Provisioning runs before the asynchronous behaviour is switched on, so the suite
      // starts from a deployed asset and an eligible wallet.
      { pollsBeforeSigning: 0 },
    );
    harness = await createHarness({ signer });
    seed = await seedAssetAndWallet(harness);
    signer.holdNewRequestsFor(1);
  }, 240_000);

  afterAll(async () => {
    await harness.close();
  });

  async function pendingMint(amount: string): Promise<{ operationId: string; attemptId: string }> {
    const mint = await requestMint(harness, seed, amount);
    await approveTwice(harness, mint.approvalRequestId);
    await harness.container.operationExecutor.execute(mint.operationId, 'worker-1');

    expect(await getOperationState(harness, mint.operationId)).toBe(OperationState.SIGNING);
    const [attempt] = await listAttemptsForOperation(harness.container.db, mint.operationId);
    if (attempt === undefined) expect.unreachable('an attempt should have been prepared');
    expect(attempt.signedRawTransaction).toBeNull();

    return { operationId: mint.operationId, attemptId: attempt.id };
  }

  async function signerRequestCount(operationId: string): Promise<number> {
    const result = await harness.container.dbHandle.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM signer_requests WHERE operation_id = $1',
      [operationId],
    );
    return Number(result.rows[0]!.count);
  }

  async function reservedNonce(): Promise<number> {
    const result = await harness.container.dbHandle.pool.query<{ next_nonce: number }>(
      'SELECT next_nonce FROM signer_nonces',
    );
    return result.rows[0]?.next_nonce ?? 0;
  }

  /** The sweep only touches operations that have stopped moving, judged by database time. */
  async function sweepStale(operationId: string): Promise<void> {
    await harness.container.db
      .update(operations)
      .set({ stateUpdatedAt: sql`now() - interval '1 hour'` })
      .where(eq(operations.id, operationId));
    await harness.container.recovery.sweep();
  }

  it('parks the operation in SIGNING and finishes it once the signature is released', async () => {
    const { operationId, attemptId } = await pendingMint('2000000000000000000');

    const request = await findSignerRequestForAttempt(harness.container.db, attemptId);
    expect(request?.status).toBe('PENDING');

    signer.release(attemptId);
    await sweepStale(operationId);

    expect(await waitForState(harness, operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );
    expect((await findSignerRequestForAttempt(harness.container.db, attemptId))?.status).toBe(
      'SIGNED',
    );
  }, 180_000);

  it('reuses the same provider request across worker restarts', async () => {
    const { operationId, attemptId } = await pendingMint('3000000000000000000');
    const first = await findSignerRequestForAttempt(harness.container.db, attemptId);

    // Two further passes stand in for restarted workers polling the outstanding request.
    await sweepStale(operationId);
    await sweepStale(operationId);

    const afterRestarts = await findSignerRequestForAttempt(harness.container.db, attemptId);
    expect(afterRestarts?.providerRequestId).toBe(first?.providerRequestId);
    expect(await listAttemptsForOperation(harness.container.db, operationId)).toHaveLength(1);

    signer.release(attemptId);
    await sweepStale(operationId);
    expect(await waitForState(harness, operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );
  }, 180_000);

  it('keeps the request outstanding when the provider is briefly unavailable', async () => {
    const { operationId, attemptId } = await pendingMint('4000000000000000000');

    signer.failNextFetches(1);
    await sweepStale(operationId);
    expect(await getOperationState(harness, operationId)).toBe(OperationState.SIGNING);
    expect((await findSignerRequestForAttempt(harness.container.db, attemptId))?.status).toBe(
      'PENDING',
    );

    // A provider that cannot be reached says nothing about the request, so it stays
    // retryable rather than being retired.
    const stillPending = await findSignerRequestForAttempt(harness.container.db, attemptId);
    expect(stillPending?.rejectionCode).toBeNull();
    expect(stillPending?.rejectedAt).toBeNull();

    signer.release(attemptId);
    await sweepStale(operationId);
    expect(await waitForState(harness, operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );
  }, 180_000);

  // The tests below withhold a broadcast, which consumes a reserved nonce without
  // sending anything, so they run after every case that needs an included transaction.
  it('fails the operation without broadcasting when the signer refuses', async () => {
    const { operationId, attemptId } = await pendingMint('1000000000000000000');

    signer.reject(attemptId, { code: 'POLICY_DENIED', reason: 'amount above signing policy' });
    await sweepStale(operationId);

    expect(await waitForState(harness, operationId, isTerminal, 60_000)).toBe(OperationState.FAILED);
    const request = await findSignerRequestForAttempt(harness.container.db, attemptId);
    expect(request?.status).toBe('REJECTED');
    expect(request?.rejectionCode).toBe('POLICY_DENIED');

    const [attempt] = await listAttemptsForOperation(harness.container.db, operationId);
    expect(attempt?.signedRawTransaction).toBeNull();
  }, 120_000);

  it('refuses signed bytes that do not match the committed request', async () => {
    const { operationId, attemptId } = await pendingMint('1000000000000000000');

    // A signature over a different nonce: verification must reject it rather than let a
    // provider decide what this application signs.
    const tampered = vi
      .spyOn(signer, 'fetchSignature')
      .mockImplementation(async (providerRequestId: string) => ({
        status: 'SIGNED' as const,
        providerRequestId,
        signerAddress: await signer.getSignerAddress(),
        signedTransaction: '0x02f8628082026d' as `0x${string}`,
        transactionHash: `0x${'11'.repeat(32)}` as `0x${string}`,
      }));

    await sweepStale(operationId).catch(() => undefined);
    tampered.mockRestore();

    const [attempt] = await listAttemptsForOperation(harness.container.db, operationId);
    expect(attempt?.signedRawTransaction).toBeNull();
    expect(attempt?.status).toBe('FAILED');
    expect(await getOperationState(harness, operationId)).toBe(OperationState.FAILED);
    expect((await findSignerRequestForAttempt(harness.container.db, attemptId))?.status).toBe(
      'PENDING',
    );
  }, 120_000);

  it('retires a request the signer never decided and ignores the signature that follows', async () => {
    const { operationId, attemptId } = await pendingMint('1000000000000000000');
    const balanceBefore = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );
    const nonceBefore = await reservedNonce();

    // The deadline is evaluated against database time, so the request is aged in the
    // database. The application clock is left alone deliberately.
    await harness.container.dbHandle.pool.query(
      `UPDATE signer_requests SET requested_at = now() - interval '1 hour' WHERE transaction_attempt_id = $1`,
      [attemptId],
    );

    await sweepStale(operationId);
    expect(await waitForState(harness, operationId, isTerminal, 60_000)).toBe(OperationState.FAILED);
    const expired = await findSignerRequestForAttempt(harness.container.db, attemptId);
    expect(expired?.status).toBe('EXPIRED');
    expect(expired?.rejectionCode).toBe('SIGNER_REQUEST_TIMEOUT');

    // The signer answers after the deadline. Nothing may act on that answer.
    signer.release(attemptId);
    await sweepStale(operationId);

    expect(await getOperationState(harness, operationId)).toBe(OperationState.FAILED);
    const attempts = await listAttemptsForOperation(harness.container.db, operationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.signedRawTransaction).toBeNull();
    expect(attempts[0]!.status).toBe('FAILED');

    const after = await findSignerRequestForAttempt(harness.container.db, attemptId);
    expect(after?.id).toBe(expired?.id);
    expect(after?.status).toBe('EXPIRED');
    expect(await signerRequestCount(operationId)).toBe(1);
    expect(await reservedNonce()).toBe(nonceBefore);
    expect(await harness.container.gateway.readBalanceOf(seed.contractAddress, seed.recipient)).toBe(
      balanceBefore,
    );
  }, 120_000);

  it('withholds a late signature when compliance was revoked while it was outstanding', async () => {
    const { operationId, attemptId } = await pendingMint('1000000000000000000');
    const balanceBefore = await harness.container.gateway.readBalanceOf(
      seed.contractAddress,
      seed.recipient,
    );

    const revocation = await harness.app.inject({
      method: 'POST',
      url: `/v1/wallets/${seed.walletId}/compliance-revocations`,
      headers: harness.auth('dev-compliance'),
      payload: { assetId: seed.assetId, reason: 'revoked while signature outstanding' },
    });
    expect(revocation.statusCode).toBe(202);

    signer.release(attemptId);
    await sweepStale(operationId);

    expect(await waitForState(harness, operationId, isTerminal, 60_000)).toBe(OperationState.FAILED);

    // The signature is real and stays as evidence; it is simply never sent.
    const [attempt] = await listAttemptsForOperation(harness.container.db, operationId);
    expect(attempt?.signedRawTransaction).not.toBeNull();
    expect(attempt?.status).toBe('FAILED');
    expect(await harness.container.gateway.readBalanceOf(seed.contractAddress, seed.recipient)).toBe(
      balanceBefore,
    );
  }, 120_000);
});
