import { createContainer, type Container } from '../src/platform/container.js';
import { getConfig } from '../src/platform/config/index.js';
import { buildApp } from '../src/api/app.js';
import { startWorkerRuntime } from '../src/worker/runtime.js';
import { bootstrapDevUsers, type DevUserSubject } from '../src/platform/bootstrap.js';
import type { AppConfig } from '../src/platform/config/index.js';
import type { EvmGateway } from '../src/ports/evm-gateway.js';

export interface JsonResponse {
  statusCode: number;
  json<T>(): T;
  body: string;
}

export interface OperationView {
  state: string;
  type: string;
  transactionHash: string | null;
  history: { state: string; at: string }[];
  reconciliation: { kind: string; matched: boolean }[];
  transactionAttempts: {
    id: string;
    status: string;
    nonce: number;
    transactionHash: string | null;
    maxFeePerGas: string;
    replacesAttemptId: string | null;
    replacedByAttemptId: string | null;
    replacementReason: string | null;
  }[];
}

export interface DemoEnvironment {
  readonly container: Container;
  readonly call: (input: {
    method: 'GET' | 'POST';
    url: string;
    as: DevUserSubject;
    payload?: unknown;
    headers?: Record<string, string>;
  }) => Promise<JsonResponse>;
  readonly awaitOperation: (operationId: string, label: string) => Promise<OperationView>;
  readonly awaitOperationState: (operationId: string, state: string, label: string) => Promise<OperationView>;
  readonly close: () => Promise<void>;
}

export interface DemoOptions {
  readonly gateway?: EvmGateway;
  readonly config?: Partial<AppConfig>;
}

export const step = (message: string): void => console.log(`  ${message}`);

export function expectStatus(response: JsonResponse, expected: number, label: string): void {
  if (response.statusCode !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.statusCode} ${response.body}`);
  }
}

const TERMINAL = ['SUCCEEDED', 'REVERTED', 'FAILED', 'CANCELLED'];

/** API, worker and Anvil wired together the way the docker-compose stack runs them. */
export async function startDemo(options: DemoOptions = {}): Promise<DemoEnvironment> {
  const container = await createContainer({
    serviceName: 'demo',
    migrate: true,
    // Progress output is the point here; warnings and errors still print.
    config: { ...getConfig(), LOG_LEVEL: 'warn', ...options.config },
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
  });
  const app = await buildApp(container);
  const users = await bootstrapDevUsers(container.db, container.auth);
  const runtime = startWorkerRuntime(container);

  const call: DemoEnvironment['call'] = async (input) => {
    const response = await app.inject({
      method: input.method,
      url: input.url,
      headers: { authorization: `Bearer ${users[input.as].token}`, ...input.headers },
      ...(input.payload === undefined ? {} : { payload: input.payload as object }),
    });
    return response;
  };

  const awaitOperation: DemoEnvironment['awaitOperation'] = async (operationId, label) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const response = await call({
        method: 'GET',
        url: `/v1/operations/${operationId}`,
        as: 'dev-issuer',
      });
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
  };

  const awaitOperationState: DemoEnvironment['awaitOperationState'] = async (
    operationId,
    state,
    label,
  ) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await call({
        method: 'GET',
        url: `/v1/operations/${operationId}`,
        as: 'dev-issuer',
      });
      expectStatus(response, 200, `read ${label}`);
      const operation = response.json<OperationView>();
      if (operation.state === state) return operation;
      if (TERMINAL.includes(operation.state)) {
        throw new Error(`${label} reached ${operation.state} instead of ${state}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label} did not reach ${state}`);
  };

  return {
    container,
    call,
    awaitOperation,
    awaitOperationState,
    close: async () => {
      await runtime.stop();
      await app.close();
      await container.close();
    },
  };
}
