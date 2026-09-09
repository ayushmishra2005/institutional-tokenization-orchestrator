import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveTwice,
  createHarness,
  getOperationState,
  isTerminal,
  randomAddress,
  requestMint,
  runOperationNow,
  seedAssetAndWallet,
  waitForState,
  type SeededAsset,
  type TestHarness,
} from './helpers.js';
import { OperationState } from '../../src/domain/operation-state.js';
import { findDecisionById } from '../../src/db/repositories/compliance-repository.js';
import { listAttemptsForOperation } from '../../src/db/repositories/transaction-repository.js';

describe('compliance decision lifecycle', () => {
  let harness: TestHarness;
  let seed: SeededAsset;

  beforeAll(async () => {
    harness = await createHarness();
    seed = await seedAssetAndWallet(harness);
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /** A wallet with a live approval mirrored on chain, on the already deployed asset. */
  async function approvedWallet(): Promise<{ walletId: string; address: `0x${string}` }> {
    const address = randomAddress();
    const wallet = await harness.app.inject({
      method: 'POST',
      url: '/v1/wallets',
      headers: harness.auth('dev-issuer'),
      payload: { address, investorReference: `investor-${randomUUID().slice(0, 8)}` },
    });
    expect(wallet.statusCode).toBe(201);
    const walletId = wallet.json<{ id: string }>().id;

    const decision = await harness.app.inject({
      method: 'POST',
      url: `/v1/wallets/${walletId}/compliance-decisions`,
      headers: harness.auth('dev-compliance'),
      payload: { assetId: seed.assetId },
    });
    expect(decision.statusCode).toBe(202);
    const sync = decision.json<{ eligibilityOperationId: string }>().eligibilityOperationId;
    await runOperationNow(harness, sync);

    return { walletId, address };
  }

  function revoke(walletId: string, reason = 'sanctions hit') {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/wallets/${walletId}/compliance-revocations`,
      headers: harness.auth('dev-compliance'),
      payload: { assetId: seed.assetId, reason },
    });
  }

  it('withdraws on-chain eligibility asynchronously when a decision is revoked', async () => {
    const wallet = await approvedWallet();
    expect(
      await harness.container.gateway.readEligibleUntil(seed.contractAddress, wallet.address),
    ).toBeGreaterThan(0n);

    const response = await revoke(wallet.walletId);
    expect(response.statusCode).toBe(202);
    const body = response.json<{ id: string; status: string; eligibilityOperationId: string }>();
    expect(body.status).toBe('REVOKED');

    await runOperationNow(harness, body.eligibilityOperationId);
    expect(
      await harness.container.gateway.readEligibleUntil(seed.contractAddress, wallet.address),
    ).toBe(0n);
  }, 120_000);

  it('treats a repeated revocation as the same withdrawal', async () => {
    const wallet = await approvedWallet();
    const first = await revoke(wallet.walletId);
    const firstBody = first.json<{ id: string; eligibilityOperationId: string }>();

    const second = await revoke(wallet.walletId);
    const secondBody = second.json<{ id: string; eligibilityOperationId: string | null }>();

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.eligibilityOperationId).toBe(firstBody.eligibilityOperationId);
    await runOperationNow(harness, firstBody.eligibilityOperationId);
  }, 120_000);

  it('retires an approval whose validity window has closed and withdraws eligibility', async () => {
    const wallet = await approvedWallet();
    const decision = await harness.container.compliance.findActiveDecision(
      wallet.walletId,
      seed.assetId,
    );
    if (decision === null) expect.unreachable('wallet should have a live approval');

    // Database time decides expiry, so the window is closed in the database rather than
    // by waiting for wall-clock time to pass.
    await harness.container.dbHandle.pool.query(
      `UPDATE compliance_decisions
          SET valid_from = now() - interval '2 hours', valid_until = now() - interval '1 hour'
        WHERE id = $1`,
      [decision.id],
    );

    expect(await harness.container.compliance.expireLapsedApprovals()).toBe(1);

    const expired = await findDecisionById(harness.container.db, decision.id);
    expect(expired?.status).toBe('EXPIRED');
    expect(
      await harness.container.compliance.findActiveDecision(wallet.walletId, seed.assetId),
    ).toBeNull();

    const sync = await harness.container.dbHandle.pool.query<{ id: string }>(
      `SELECT id FROM operations
        WHERE type = 'SYNC_ELIGIBILITY' AND wallet_id = $1 AND state = 'READY'`,
      [wallet.walletId],
    );
    expect(sync.rows).toHaveLength(1);
    await runOperationNow(harness, sync.rows[0]!.id);
    expect(
      await harness.container.gateway.readEligibleUntil(seed.contractAddress, wallet.address),
    ).toBe(0n);
  }, 120_000);

  it('records a new approval when a wallet is re-screened after expiry', async () => {
    const wallet = await approvedWallet();
    const original = await harness.container.compliance.findActiveDecision(
      wallet.walletId,
      seed.assetId,
    );
    await harness.container.dbHandle.pool.query(
      `UPDATE compliance_decisions
          SET valid_from = now() - interval '2 hours', valid_until = now() - interval '1 hour'
        WHERE id = $1`,
      [original!.id],
    );

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: `/v1/wallets/${wallet.walletId}/compliance-decisions`,
      headers: harness.auth('dev-compliance'),
      payload: { assetId: seed.assetId },
    });
    expect(refreshed.statusCode).toBe(202);

    const live = await harness.container.compliance.findActiveDecision(
      wallet.walletId,
      seed.assetId,
    );
    expect(live?.id).not.toBe(original!.id);
    expect(live?.validUntil.getTime()).toBeGreaterThan(Date.now());
    const sync = refreshed.json<{ eligibilityOperationId: string }>().eligibilityOperationId;
    await runOperationNow(harness, sync);
  }, 120_000);

  it('does not undo a mint that was already broadcast', async () => {
    const wallet = await approvedWallet();
    const mint = await requestMint(
      harness,
      { ...seed, walletId: wallet.walletId, recipient: wallet.address },
      '5000000000000000000',
    );
    await approveTwice(harness, mint.approvalRequestId);
    await harness.container.operationExecutor.execute(mint.operationId, 'test-runner');
    expect(await waitForState(harness, mint.operationId, isTerminal, 90_000)).toBe(
      OperationState.SUCCEEDED,
    );

    const revocation = await revoke(wallet.walletId, 'post-settlement finding');
    expect(revocation.statusCode).toBe(202);

    // The chain cannot take a settled mint back: the operation stays SUCCEEDED, the
    // tokens stay minted, and only future eligibility changes.
    expect(await getOperationState(harness, mint.operationId)).toBe(OperationState.SUCCEEDED);
    expect(await harness.container.gateway.readBalanceOf(seed.contractAddress, wallet.address)).toBe(
      5000000000000000000n,
    );

    await runOperationNow(
      harness,
      revocation.json<{ eligibilityOperationId: string }>().eligibilityOperationId,
    );
    expect(
      await harness.container.gateway.readEligibleUntil(seed.contractAddress, wallet.address),
    ).toBe(0n);
  }, 180_000);

  it('refuses to execute a mint whose approval was revoked before signing', async () => {
    const wallet = await approvedWallet();
    const mint = await requestMint(
      harness,
      { ...seed, walletId: wallet.walletId, recipient: wallet.address },
      '1000000000000000000',
    );
    await approveTwice(harness, mint.approvalRequestId);

    const revocation = await revoke(wallet.walletId, 'revoked while awaiting execution');
    expect(revocation.statusCode).toBe(202);

    await harness.container.operationExecutor.execute(mint.operationId, 'test-runner');
    expect(await waitForState(harness, mint.operationId, isTerminal, 90_000)).toBe(
      OperationState.FAILED,
    );

    // Refused before a nonce was signed, so there is nothing on chain to reconcile.
    const attempts = await listAttemptsForOperation(harness.container.db, mint.operationId);
    expect(attempts).toHaveLength(0);
    expect(await harness.container.gateway.readBalanceOf(seed.contractAddress, wallet.address)).toBe(
      0n,
    );
  }, 180_000);
});
