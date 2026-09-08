/**
 * End-to-end local demonstration of the mint vertical slice.
 *
 * Runs the API in-process (via light-my-request style injection), starts a real worker
 * against Redis/BullMQ and drives a mint through approval, signing, broadcast,
 * confirmation and reconciliation on a local Anvil chain.
 *
 * No private key material is printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createContainer } from '../src/platform/container.js';
import { getConfig } from '../src/platform/config/index.js';
import { buildApp } from '../src/api/app.js';
import { startWorkerRuntime } from '../src/worker/runtime.js';
import { bootstrapDevUsers } from '../src/platform/bootstrap.js';
import { OperationState } from '../src/domain/operation-state.js';

const step = (message: string): void => console.log(`  ${message}`);

// Progress is the output here, so routine logs are suppressed. Warnings and errors
// still print, since a silent demo that quietly went wrong would be worse than noisy.
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
  transactionAttempts: { transactionHash: string | null; status: string }[];
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

try {
  console.log('\nInstitutional tokenization orchestrator - local mint demo\n');

  // 1. asset
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
  expectStatus(assetResponse, 201, 'create asset');
  const asset = assetResponse.json<{ id: string; symbol: string; contractAddress: string }>();
  step(`asset created            ${asset.symbol} (${asset.id})`);
  step(`contract deployed        ${asset.contractAddress}`);

  // 2. wallet
  // A fresh recipient each run keeps the demo repeatable against a persistent database.
  // The recipient only ever receives tokens, so it needs no funded key.
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

  // 3. compliance
  const complianceResponse = (await app.inject({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-decisions`,
    headers: auth(users['dev-compliance'].token),
    payload: { assetId: asset.id },
  })) as JsonResponse;
  expectStatus(complianceResponse, 201, 'compliance decision');
  const compliance = complianceResponse.json<{ status: string; chainSyncStatus: string }>();
  step(`compliance approved      status=${compliance.status} (mock provider, not real KYC)`);

  // 4. mint request
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

  // 5. two independent approvals
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
    if (index === 1) step(`operation ready          ${result.operationState}`);
  }

  // 6. wait for the worker to carry the operation through to a terminal state
  const deadline = Date.now() + 120_000;
  let operation: OperationView | null = null;
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/operations/${mint.operationId}`,
      headers: auth(users['dev-issuer'].token),
    })) as JsonResponse;
    expectStatus(response, 200, 'get operation');
    operation = response.json<OperationView>();

    if (!seen.has(operation.state)) {
      seen.add(operation.state);
      if (operation.state === OperationState.SUBMITTED) step('transaction submitted    on chain');
      if (operation.state === OperationState.INCLUDED) step('transaction confirmed    receipt observed');
    }

    if (
      operation.state === OperationState.SUCCEEDED ||
      operation.state === OperationState.REVERTED ||
      operation.state === OperationState.FAILED ||
      operation.state === OperationState.CANCELLED
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (operation === null) throw new Error('operation was never observed');
  if (operation.state !== OperationState.SUCCEEDED) {
    throw new Error(`operation ended in ${operation.state}, expected SUCCEEDED`);
  }

  const matched = operation.reconciliation.filter((entry) => entry.matched).length;
  step(`mint reconciled          ${matched}/${operation.reconciliation.length} chain checks matched`);
  step(`operation succeeded      ${operation.state}`);

  const transactionHash =
    operation.transactionAttempts.find((attempt) => attempt.transactionHash !== null)
      ?.transactionHash ?? 'unknown';

  const balance = await container.gateway.readBalanceOf(
    asset.contractAddress as `0x${string}`,
    recipient as `0x${string}`,
  );

  console.log('\nResult');
  console.log(`  operation ID:      ${mint.operationId}`);
  console.log(`  transaction hash:  ${transactionHash}`);
  console.log(`  contract address:  ${asset.contractAddress}`);
  console.log(`  recipient:         ${recipient}`);
  console.log(`  minted amount:     ${amount} base units (recipient balance ${balance})`);
  console.log(`  final state:       ${operation.state}\n`);
} finally {
  await runtime.stop();
  await app.close();
  await container.close();
}
