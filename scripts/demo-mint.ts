/**
 * Drives the whole local slice: API in-process, a real BullMQ worker, and every chain
 * write (deployment, eligibility, mint) carried through the asynchronous operation path
 * to confirmation and reconciliation on Anvil.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expectStatus, startDemo, step } from './demo-support.js';

const demo = await startDemo();
const { call, awaitOperation, container } = demo;
const suffix = randomUUID().slice(0, 4).toUpperCase();

try {
  console.log('\nInstitutional tokenization orchestrator - local mint demo\n');

  const assetResponse = await call({
    method: 'POST',
    url: '/v1/assets',
    as: 'dev-issuer',
    payload: {
      symbol: `DEMO${suffix}`.slice(0, 12),
      name: 'Demo Institutional Fund Token',
      decimals: 18,
      supplyCap: '1000000000000000000000000',
    },
  });
  expectStatus(assetResponse, 202, 'create asset');
  const asset = assetResponse.json<{
    id: string;
    symbol: string;
    provisioningOperationId: string;
  }>();
  step(`asset accepted           ${asset.symbol} (${asset.id})`);

  const deployment = await awaitOperation(asset.provisioningOperationId, 'asset deployment');
  const assetView = await call({ method: 'GET', url: `/v1/assets/${asset.id}`, as: 'dev-issuer' });
  expectStatus(assetView, 200, 'get asset');
  const contractAddress = assetView.json<{ contractAddress: string }>().contractAddress;
  step(`contract deployed        ${contractAddress}`);
  step(`deployment tx            ${deployment.transactionHash}`);

  // A fresh recipient each run keeps the demo repeatable against a persistent database.
  const recipient = `0x${randomBytes(20).toString('hex')}`;
  const walletResponse = await call({
    method: 'POST',
    url: '/v1/wallets',
    as: 'dev-issuer',
    payload: {
      address: recipient,
      investorReference: `investor-${suffix}`,
      label: 'Demo institutional investor',
    },
  });
  expectStatus(walletResponse, 201, 'register wallet');
  const wallet = walletResponse.json<{ id: string; address: string }>();
  step(`wallet registered        ${wallet.address}`);

  const complianceResponse = await call({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-decisions`,
    as: 'dev-compliance',
    payload: { assetId: asset.id },
  });
  expectStatus(complianceResponse, 202, 'compliance decision');
  const compliance = complianceResponse.json<{ status: string; eligibilityOperationId: string }>();
  step(`compliance approved      status=${compliance.status} (mock provider, not real KYC)`);
  await awaitOperation(compliance.eligibilityOperationId, 'eligibility sync');
  step('eligibility synced       on chain');

  const amount = '2500000000000000000000';
  const mintResponse = await call({
    method: 'POST',
    url: `/v1/assets/${asset.id}/mints`,
    as: 'dev-issuer',
    headers: { 'idempotency-key': `demo-${randomUUID()}` },
    payload: { walletId: wallet.id, amount },
  });
  expectStatus(mintResponse, 202, 'request mint');
  const mint = mintResponse.json<{ operationId: string; approvalRequestId: string }>();
  step(`mint requested           operation=${mint.operationId}`);

  for (const [index, approver] of (['dev-approver-1', 'dev-approver-2'] as const).entries()) {
    const decision = await call({
      method: 'POST',
      url: `/v1/approval-requests/${mint.approvalRequestId}/decisions`,
      as: approver,
      payload: { decision: 'APPROVE', comment: `demo approval ${index + 1}` },
    });
    expectStatus(decision, 200, `approval ${index + 1}`);
    const result = decision.json<{ operationState: string; approvalsRecorded: number }>();
    step(
      `approval ${index + 1} recorded       approvals=${result.approvalsRecorded} operation=${result.operationState}`,
    );
  }

  const operation = await awaitOperation(mint.operationId, 'mint');
  step(`operation history        ${operation.history.map((entry) => entry.state).join(' -> ')}`);

  const matched = operation.reconciliation.filter((entry) => entry.matched).length;
  step(`mint reconciled          ${matched}/${operation.reconciliation.length} chain checks matched`);

  const balance = await container.gateway.readBalanceOf(
    contractAddress as `0x${string}`,
    recipient as `0x${string}`,
  );

  console.log('\nResult');
  console.log(`  operation ID:      ${mint.operationId}`);
  console.log(`  transaction hash:  ${operation.transactionHash ?? 'unknown'}`);
  console.log(`  contract address:  ${contractAddress}`);
  console.log(`  recipient:         ${recipient}`);
  console.log(`  minted amount:     ${amount} base units (recipient balance ${balance})`);
  console.log(`  final state:       ${operation.state}\n`);
} finally {
  await demo.close();
}
