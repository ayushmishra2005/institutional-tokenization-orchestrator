/**
 * Drives the whole local slice: API in-process, a real BullMQ worker, and every chain
 * write (deployment, eligibility, mint) carried through the asynchronous operation path
 * to confirmation and reconciliation on Anvil.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createContainer } from '../src/platform/container.js';
import { getConfig } from '../src/platform/config/index.js';
import { buildApp } from '../src/api/app.js';
import { startWorkerRuntime } from '../src/worker/runtime.js';
import { bootstrapDevUsers } from '../src/platform/bootstrap.js';

const step = (message: string): void => console.log(`  ${message}`);

// Progress output is the point here; warnings and errors still print.
const container = await createContainer({
  serviceName: 'demo',
  migrate: true,
  config: { ...getConfig(), LOG_LEVEL: 'warn' },
});
const app = await buildApp(container);
const users = await bootstrapDevUsers(container.db, container.auth);
const runtime = startWorkerRuntime(container);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const suffix = randomUUID().slice(0, 4).toUpperCase();

interface OperationView {
  state: string;
  type: string;
  transactionHash: string | null;
  history: { state: string; at: string }[];
  reconciliation: { kind: string; matched: boolean }[];
}

interface JsonResponse {
  statusCode: number;
  json<T>(): T;
  body: string;
}

function expectStatus(response: JsonResponse, expected: number, label: string): void {
  if (response.statusCode !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.statusCode} ${response.body}`);
  }
}

const TERMINAL = ['SUCCEEDED', 'REVERTED', 'FAILED', 'CANCELLED'];

/** Polls until the worker carries an operation to a terminal state. */
async function awaitOperation(operationId: string, label: string): Promise<OperationView> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/operations/${operationId}`,
      headers: auth(users['dev-issuer'].token),
    })) as JsonResponse;
    expectStatus(response, 200, `read ${label}`);
    const operation = response.json<OperationView>();

    if (TERMINAL.includes(operation.state)) {
      if (operation.state !== 'SUCCEEDED') {
        throw new Error(`${label} ended in ${operation.state}`);
      }
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not reach a terminal state`);
}

try {
  console.log('\nInstitutional tokenization orchestrator - local mint demo\n');

  const assetResponse = (await app.inject({
    method: 'POST',
    url: '/v1/assets',
    headers: auth(users['dev-issuer'].token),
    payload: {
      symbol: `DEMO${suffix}`.slice(0, 12),
      name: 'Demo Institutional Fund Token',
      decimals: 18,
      supplyCap: '1000000000000000000000000',
    },
  })) as JsonResponse;
  expectStatus(assetResponse, 202, 'create asset');
  const asset = assetResponse.json<{
    id: string;
    symbol: string;
    provisioningOperationId: string;
  }>();
  step(`asset accepted           ${asset.symbol} (${asset.id})`);

  const deployment = await awaitOperation(asset.provisioningOperationId, 'asset deployment');
  const assetView = (await app.inject({
    method: 'GET',
    url: `/v1/assets/${asset.id}`,
    headers: auth(users['dev-issuer'].token),
  })) as JsonResponse;
  expectStatus(assetView, 200, 'get asset');
  const contractAddress = assetView.json<{ contractAddress: string }>().contractAddress;
  step(`contract deployed        ${contractAddress}`);
  step(`deployment tx            ${deployment.transactionHash}`);

  // A fresh recipient each run keeps the demo repeatable against a persistent database.
  const recipient = `0x${randomBytes(20).toString('hex')}`;
  const walletResponse = (await app.inject({
    method: 'POST',
    url: '/v1/wallets',
    headers: auth(users['dev-issuer'].token),
    payload: {
      address: recipient,
      investorReference: `investor-${suffix}`,
      label: 'Demo institutional investor',
    },
  })) as JsonResponse;
  expectStatus(walletResponse, 201, 'register wallet');
  const wallet = walletResponse.json<{ id: string; address: string }>();
  step(`wallet registered        ${wallet.address}`);

  const complianceResponse = (await app.inject({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-decisions`,
    headers: auth(users['dev-compliance'].token),
    payload: { assetId: asset.id },
  })) as JsonResponse;
  expectStatus(complianceResponse, 202, 'compliance decision');
  const compliance = complianceResponse.json<{
    status: string;
    eligibilityOperationId: string;
  }>();
  step(`compliance approved      status=${compliance.status} (mock provider, not real KYC)`);
  await awaitOperation(compliance.eligibilityOperationId, 'eligibility sync');
  step('eligibility synced       on chain');

  const amount = '2500000000000000000000';
  const mintResponse = (await app.inject({
    method: 'POST',
    url: `/v1/assets/${asset.id}/mints`,
    headers: { ...auth(users['dev-issuer'].token), 'idempotency-key': `demo-${randomUUID()}` },
    payload: { walletId: wallet.id, amount },
  })) as JsonResponse;
  expectStatus(mintResponse, 202, 'request mint');
  const mint = mintResponse.json<{ operationId: string; approvalRequestId: string }>();
  step(`mint requested           operation=${mint.operationId}`);

  for (const [index, approver] of ['dev-approver-1', 'dev-approver-2'].entries()) {
    const decision = (await app.inject({
      method: 'POST',
      url: `/v1/approval-requests/${mint.approvalRequestId}/decisions`,
      headers: auth(users[approver as 'dev-approver-1'].token),
      payload: { decision: 'APPROVE', comment: `demo approval ${index + 1}` },
    })) as JsonResponse;
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
  await runtime.stop();
  await app.close();
  await container.close();
}
