import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createContainer, type Container } from '../../src/platform/container.js';
import { buildApp } from '../../src/api/app.js';
import { getConfig, type AppConfig } from '../../src/platform/config/index.js';
import {
  bootstrapDevUsers,
  type BootstrappedUser,
  type DevUserSubject,
} from '../../src/platform/bootstrap.js';
import type { EvmGateway } from '../../src/ports/evm-gateway.js';
import type { ComplianceProvider } from '../../src/ports/compliance-provider.js';
import { OperationState } from '../../src/domain/operation-state.js';

const APPLICATION_TABLES = [
  'chain_observations',
  'transaction_attempts',
  'signer_nonces',
  'audit_events',
  'outbox',
  'idempotency_keys',
  'approval_decisions',
  'approval_requests',
  'operations',
  'compliance_decisions',
  'wallets',
  'assets',
  'user_roles',
  'users',
];

export interface TestHarness {
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly users: Record<DevUserSubject, BootstrappedUser>;
  auth(subject: DevUserSubject): { authorization: string };
  reset(): Promise<void>;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = getConfig();
  return Object.freeze({
    ...base,
    LOG_LEVEL: 'silent' as const,
    // A per-suite queue prefix keeps concurrently retained BullMQ state isolated.
    QUEUE_PREFIX: `itotest-${randomBytes(4).toString('hex')}`,
    OUTBOX_POLL_INTERVAL_MS: 100,
    RECOVERY_SWEEP_INTERVAL_MS: 500,
    RECOVERY_STALE_AFTER_MS: 1000,
    EVM_CONFIRMATIONS: 1,
    EVM_RECEIPT_TIMEOUT_MS: 30_000,
    ...overrides,
  });
}

export async function createHarness(
  options: {
    gateway?: EvmGateway;
    complianceProvider?: ComplianceProvider;
    config?: Partial<AppConfig>;
  } = {},
): Promise<TestHarness> {
  const container = await createContainer({
    serviceName: 'test',
    config: testConfig(options.config ?? {}),
    migrate: true,
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    ...(options.complianceProvider === undefined
      ? {}
      : { complianceProvider: options.complianceProvider }),
  });

  await truncateAll(container);
  const app = await buildApp(container);
  const users = await bootstrapDevUsers(container.db, container.auth);

  return {
    container,
    app,
    users,
    auth: (subject: DevUserSubject) => ({ authorization: `Bearer ${users[subject].token}` }),
    reset: async () => {
      await truncateAll(container);
      Object.assign(users, await bootstrapDevUsers(container.db, container.auth));
    },
    close: async () => {
      await app.close();
      await container.close();
    },
  };
}

async function truncateAll(container: Container): Promise<void> {
  // TRUNCATE does not fire the per-row append-only trigger on audit_events, so test
  // isolation does not require weakening that protection.
  await container.dbHandle.pool.query(
    `TRUNCATE TABLE ${APPLICATION_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export function randomAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString('hex')}`;
}

export function uniqueSymbol(): string {
  return `T${randomBytes(3).toString('hex').toUpperCase()}`;
}

export interface SeededAsset {
  readonly assetId: string;
  readonly contractAddress: `0x${string}`;
  readonly walletId: string;
  readonly recipient: `0x${string}`;
}

/**
 * Runs an administrative operation to completion without requiring a live worker, so
 * suites that only exercise the API still get a deployed contract. Waits rather than
 * asserting on the return value, because a running dispatcher may win the claim race.
 */
export async function runOperationNow(
  harness: TestHarness,
  operationId: string,
): Promise<void> {
  await harness.container.operationExecutor.execute(operationId, 'test-runner');
  const state = await waitForState(harness, operationId, isTerminal, 60_000);
  if (state !== OperationState.SUCCEEDED) {
    throw new Error(`operation ${operationId} ended in ${state}, expected SUCCEEDED`);
  }
}

/** Creates a deployed asset, a registered wallet and a synced compliance approval. */
export async function seedAssetAndWallet(harness: TestHarness): Promise<SeededAsset> {
  const assetResponse = await harness.app.inject({
    method: 'POST',
    url: '/v1/assets',
    headers: harness.auth('dev-issuer'),
    payload: {
      symbol: uniqueSymbol(),
      name: 'Integration Test Token',
      decimals: 18,
      supplyCap: '1000000000000000000000000',
    },
  });
  if (assetResponse.statusCode !== 202) {
    throw new Error(`asset creation failed: ${assetResponse.body}`);
  }
  const asset = assetResponse.json<{ id: string; provisioningOperationId: string }>();
  await runOperationNow(harness, asset.provisioningOperationId);

  const deployed = await harness.app.inject({
    method: 'GET',
    url: `/v1/assets/${asset.id}`,
    headers: harness.auth('dev-issuer'),
  });
  const contractAddress = deployed.json<{ contractAddress: string | null }>().contractAddress;
  if (contractAddress === null) throw new Error('asset has no contract after deployment');

  const recipient = randomAddress();
  const walletResponse = await harness.app.inject({
    method: 'POST',
    url: '/v1/wallets',
    headers: harness.auth('dev-issuer'),
    payload: { address: recipient, investorReference: `investor-${randomUUID().slice(0, 8)}` },
  });
  if (walletResponse.statusCode !== 201) {
    throw new Error(`wallet registration failed: ${walletResponse.body}`);
  }
  const wallet = walletResponse.json<{ id: string }>();

  const complianceResponse = await harness.app.inject({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-decisions`,
    headers: harness.auth('dev-compliance'),
    payload: { assetId: asset.id },
  });
  if (complianceResponse.statusCode !== 202) {
    throw new Error(`compliance decision failed: ${complianceResponse.body}`);
  }
  const eligibilityOperationId =
    complianceResponse.json<{ eligibilityOperationId: string }>().eligibilityOperationId;
  await runOperationNow(harness, eligibilityOperationId);

  return {
    assetId: asset.id,
    contractAddress: contractAddress as `0x${string}`,
    walletId: wallet.id,
    recipient,
  };
}

export interface RequestedMint {
  readonly operationId: string;
  readonly approvalRequestId: string;
}

export async function requestMint(
  harness: TestHarness,
  seed: SeededAsset,
  amount = '1000000000000000000000',
  idempotencyKey = `key-${randomUUID()}`,
): Promise<RequestedMint> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/assets/${seed.assetId}/mints`,
    headers: { ...harness.auth('dev-issuer'), 'idempotency-key': idempotencyKey },
    payload: { walletId: seed.walletId, amount },
  });
  if (response.statusCode !== 202) throw new Error(`mint request failed: ${response.body}`);
  return response.json<RequestedMint>();
}

/** Records both approvals, moving the operation to READY. */
export async function approveTwice(
  harness: TestHarness,
  approvalRequestId: string,
): Promise<void> {
  for (const approver of ['dev-approver-1', 'dev-approver-2'] as const) {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/approval-requests/${approvalRequestId}/decisions`,
      headers: harness.auth(approver),
      payload: { decision: 'APPROVE' },
    });
    if (response.statusCode !== 200) throw new Error(`approval failed: ${response.body}`);
  }
}

export async function getOperationState(
  harness: TestHarness,
  operationId: string,
): Promise<string> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/operations/${operationId}`,
    headers: harness.auth('dev-issuer'),
  });
  return response.json<{ state: string }>().state;
}

export async function waitForState(
  harness: TestHarness,
  operationId: string,
  predicate: (state: string) => boolean,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await getOperationState(harness, operationId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`operation ${operationId} stuck in ${last}`);
}

const TERMINAL_STATES: readonly string[] = [
  OperationState.SUCCEEDED,
  OperationState.REVERTED,
  OperationState.FAILED,
  OperationState.CANCELLED,
];

export const isTerminal = (state: string): boolean => TERMINAL_STATES.includes(state);
