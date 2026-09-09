/**
 * Shows what happens to an eligible, already-minted wallet when compliance withdraws its
 * approval: the settled mint stands, on-chain eligibility is withdrawn asynchronously,
 * and a further mint is refused before anything is signed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expectStatus, startDemo, step } from './demo-support.js';

const demo = await startDemo();
const { call, awaitOperation, container } = demo;
const suffix = randomUUID().slice(0, 4).toUpperCase();

async function approveMint(approvalRequestId: string): Promise<void> {
  for (const approver of ['dev-approver-1', 'dev-approver-2'] as const) {
    const decision = await call({
      method: 'POST',
      url: `/v1/approval-requests/${approvalRequestId}/decisions`,
      as: approver,
      payload: { decision: 'APPROVE' },
    });
    expectStatus(decision, 200, `approval by ${approver}`);
  }
}

try {
  console.log('\nInstitutional tokenization orchestrator - compliance revocation demo\n');

  const assetResponse = await call({
    method: 'POST',
    url: '/v1/assets',
    as: 'dev-issuer',
    payload: {
      symbol: `REVK${suffix}`.slice(0, 12),
      name: 'Demo Revocation Token',
      decimals: 18,
      supplyCap: '1000000000000000000000000',
    },
  });
  expectStatus(assetResponse, 202, 'create asset');
  const asset = assetResponse.json<{ id: string; provisioningOperationId: string }>();
  await awaitOperation(asset.provisioningOperationId, 'asset deployment');

  const assetView = await call({ method: 'GET', url: `/v1/assets/${asset.id}`, as: 'dev-issuer' });
  const contractAddress = assetView.json<{ contractAddress: string }>()
    .contractAddress as `0x${string}`;
  step(`contract deployed        ${contractAddress}`);

  const recipient = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;
  const walletResponse = await call({
    method: 'POST',
    url: '/v1/wallets',
    as: 'dev-issuer',
    payload: { address: recipient, investorReference: `investor-${suffix}` },
  });
  expectStatus(walletResponse, 201, 'register wallet');
  const wallet = walletResponse.json<{ id: string }>();

  const approval = await call({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-decisions`,
    as: 'dev-compliance',
    payload: { assetId: asset.id },
  });
  expectStatus(approval, 202, 'compliance decision');
  await awaitOperation(
    approval.json<{ eligibilityOperationId: string }>().eligibilityOperationId,
    'eligibility sync',
  );
  const grantedUntil = await container.gateway.readEligibleUntil(contractAddress, recipient);
  step(`eligibility granted      until unix ${grantedUntil}`);

  const mintResponse = await call({
    method: 'POST',
    url: `/v1/assets/${asset.id}/mints`,
    as: 'dev-issuer',
    headers: { 'idempotency-key': `demo-${randomUUID()}` },
    payload: { walletId: wallet.id, amount: '1000000000000000000000' },
  });
  expectStatus(mintResponse, 202, 'request mint');
  const mint = mintResponse.json<{ operationId: string; approvalRequestId: string }>();
  await approveMint(mint.approvalRequestId);
  const settled = await awaitOperation(mint.operationId, 'mint');
  step(`mint settled             ${settled.transactionHash}`);

  const revocation = await call({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-revocations`,
    as: 'dev-compliance',
    payload: { assetId: asset.id, reason: 'demo: adverse media finding' },
  });
  expectStatus(revocation, 202, 'revoke compliance');
  const revoked = revocation.json<{ status: string; eligibilityOperationId: string }>();
  step(`compliance revoked       status=${revoked.status} (HTTP returns before the chain write)`);

  await awaitOperation(revoked.eligibilityOperationId, 'eligibility withdrawal');
  const withdrawnUntil = await container.gateway.readEligibleUntil(contractAddress, recipient);
  step(`eligibility withdrawn    until unix ${withdrawnUntil}`);

  const blocked = await call({
    method: 'POST',
    url: `/v1/assets/${asset.id}/mints`,
    as: 'dev-issuer',
    headers: { 'idempotency-key': `demo-${randomUUID()}` },
    payload: { walletId: wallet.id, amount: '1000000000000000000' },
  });
  const refusal = blocked.json<{ error: { code: string } }>().error.code;
  step(`further mint refused     HTTP ${blocked.statusCode} ${refusal}`);

  console.log('\nResult');
  console.log(`  settled mint:      ${settled.state} (not undone by the revocation)`);
  const balance = await container.gateway.readBalanceOf(contractAddress, recipient);
  console.log(`  recipient balance: ${balance}`);
  console.log(`  on-chain eligible: until unix ${withdrawnUntil}\n`);
} finally {
  await demo.close();
}
