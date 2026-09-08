import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Container } from '../platform/container.js';
import { normalizeError } from './errors.js';
import { DevJwtAuthenticator } from '../platform/auth/jwt.js';
import { findUserBySubject, toActor } from '../db/repositories/user-repository.js';
import { UnauthorizedError, AppError, ErrorCode, NotFoundError } from '../domain/errors.js';
import type { RequestContext } from '../modules/context.js';
import { listOperationHistory } from '../db/repositories/operation-repository.js';
import { listAttemptsForOperation, listObservations } from '../db/repositories/transaction-repository.js';
import type { AssetRecord } from '../db/repositories/asset-repository.js';
import type { WalletRecord } from '../db/repositories/wallet-repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Populated by the onRequest hook before any handler runs.
    ctx: RequestContext;
  }
}

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed EVM address');

const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/, 'must be a positive integer string in base units');

const createAssetSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,12}$/),
  name: z.string().min(1).max(128),
  decimals: z.number().int().min(0).max(18),
  supplyCap: amountSchema,
});

const createWalletSchema = z.object({
  address: addressSchema,
  investorReference: z.string().min(1).max(128),
  label: z.string().max(128).optional(),
});

const complianceDecisionSchema = z.object({
  assetId: z.string().uuid().optional(),
  subjectReference: z.string().min(1).max(128).optional(),
});

const createMintSchema = z.object({
  walletId: z.string().uuid(),
  amount: amountSchema,
});

const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comment: z.string().max(1024).optional(),
});

const auditQuerySchema = z.object({
  operationId: z.string().uuid().optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(128).optional(),
});

/**
 * Handlers parse input, call one application service and shape the response. Authorization,
 * state and persistence decisions belong to the services so the worker obeys the same rules.
 */
export async function buildApp(container: Container): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    genReqId: (request) => (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });

  app.decorateRequest('ctx');

  app.addHook('onRequest', async (request, reply) => {
    const correlationId =
      (request.headers['x-correlation-id'] as string | undefined) ?? String(request.id);
    reply.header('x-request-id', String(request.id));
    reply.header('x-correlation-id', correlationId);

    request.ctx = {
      // Replaced by the authenticated actor below; unauthenticated routes never use it.
      actor: { type: 'SYSTEM', id: 'anonymous', organizationId: 'none', roles: [] },
      correlationId,
      requestId: String(request.id),
      logger: container.logger.child({ requestId: String(request.id), correlationId }),
    };
  });

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const token = DevJwtAuthenticator.parseBearer(request.headers.authorization);
    const subject = await container.auth.verify(token);

    // Roles come from PostgreSQL, not from the token.
    const user = await findUserBySubject(container.db, subject.subject);
    if (user === null) throw new UnauthorizedError('token subject is not a known user');
    if (user.status !== 'ACTIVE') throw new UnauthorizedError('user is disabled');

    request.ctx = {
      ...request.ctx,
      actor: toActor(user),
      logger: request.ctx.logger.child({ actorId: user.id }),
    };
  };

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    container.metrics.httpRequestsTotal.inc(labels);
    container.metrics.httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error, {
      requestId: request.ctx?.requestId ?? String(request.id),
      correlationId: request.ctx?.correlationId ?? String(request.id),
      logger: request.ctx?.logger ?? container.logger,
    });
    void reply.status(normalized.status).send(normalized.body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: ErrorCode.RESOURCE_NOT_FOUND,
        message: 'route not found',
        requestId: String(request.id),
        correlationId: request.ctx?.correlationId ?? String(request.id),
      },
    });
  });

  // Liveness only answers whether this process is still serving; it must never depend on
  // a dependency, or a brief PostgreSQL blip would get the API killed instead of drained.
  app.get('/health/live', async () => ({ status: 'ok' }));

  // The API's synchronous work is reading and writing PostgreSQL. It records intent and
  // returns; the chain and the queue are the worker's problem, so a degraded RPC endpoint
  // must not take the API out of the load balancer.
  app.get('/health/ready', async (_request, reply) => {
    const postgres = await checkReadiness(() => container.db.execute('SELECT 1'));
    const ready = postgres === 'ok';
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'degraded', checks: { postgres } });
  });

  app.get('/metrics', async (_request, reply) => {
    if (!container.config.METRICS_ENABLED) return reply.status(404).send();
    return reply
      .header('content-type', container.metrics.contentType())
      .send(await container.metrics.render());
  });

  // Deployment is a chain write, so the response is an accepted intent plus the operation
  // to poll. The asset is not usable until that operation reaches SUCCEEDED.
  app.post('/v1/assets', { onRequest: authenticate }, async (request, reply) => {
    const body = createAssetSchema.parse(request.body);
    const created = await container.assets.createAsset(request.ctx, body);
    return reply
      .status(202)
      .send({ ...serializeAsset(created.asset), provisioningOperationId: created.operationId });
  });

  app.post('/v1/assets/:assetId/deployments', { onRequest: authenticate }, async (request, reply) => {
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const operation = await container.assets.requestDeployment(request.ctx, assetId);
    return reply.status(202).send({ operationId: operation.id, state: operation.state });
  });

  app.get('/v1/assets/:assetId', { onRequest: authenticate }, async (request) => {
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    return serializeAsset(await container.assets.getAsset(request.ctx, assetId));
  });

  app.post('/v1/wallets', { onRequest: authenticate }, async (request, reply) => {
    const body = createWalletSchema.parse(request.body);
    const wallet = await container.wallets.registerWallet(request.ctx, body);
    return reply.status(201).send(serializeWallet(wallet));
  });

  app.post(
    '/v1/wallets/:walletId/compliance-decisions',
    { onRequest: authenticate },
    async (request, reply) => {
      const { walletId } = z.object({ walletId: z.string().uuid() }).parse(request.params);
      const body = complianceDecisionSchema.parse(request.body ?? {});
      const { decision, operationId } = await container.compliance.recordDecision(request.ctx, {
        walletId,
        ...body,
      });
      // 202 whenever an on-chain eligibility write was queued; the decision itself is
      // already durable, but the chain does not reflect it yet.
      return reply.status(operationId === null ? 201 : 202).send({
        id: decision.id,
        walletId: decision.walletId,
        assetId: decision.assetId,
        status: decision.status,
        provider: decision.provider,
        providerReference: decision.providerReference,
        validFrom: decision.validFrom.toISOString(),
        validUntil: decision.validUntil.toISOString(),
        decidedAt: decision.decidedAt.toISOString(),
        chainSyncStatus: decision.chainSyncStatus,
        eligibilityOperationId: operationId,
      });
    },
  );

  app.post('/v1/assets/:assetId/mints', { onRequest: authenticate }, async (request, reply) => {
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      throw new AppError(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'the Idempotency-Key header is required and must be at least 8 characters',
      );
    }

    const body = createMintSchema.parse(request.body);
    const result = await container.mints.requestMint(request.ctx, {
      assetId,
      walletId: body.walletId,
      amount: body.amount,
      idempotencyKey,
    });

    return reply
      .status(result.httpStatus)
      .header('idempotent-replay', String(result.replayed))
      .send({
        operationId: result.operationId,
        approvalRequestId: result.approvalRequestId,
        state: result.state,
        requiredApprovals: result.requiredApprovals,
      });
  });

  app.post(
    '/v1/approval-requests/:requestId/decisions',
    { onRequest: authenticate },
    async (request, reply) => {
      const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
      const body = approvalDecisionSchema.parse(request.body);
      const result = await container.approvals.recordDecision(request.ctx, {
        approvalRequestId: requestId,
        ...body,
      });
      return reply.status(200).send(result);
    },
  );

  app.get('/v1/operations/:operationId', { onRequest: authenticate }, async (request) => {
    const { operationId } = z.object({ operationId: z.string().uuid() }).parse(request.params);
    const operation = await container.mints.getOperation(request.ctx, operationId);
    if (operation === null) throw new NotFoundError('operation', operationId);

    const attempts = await listAttemptsForOperation(container.db, operation.id);
    const observations = await listObservations(container.db, operation.id);
    const history = await listOperationHistory(container.db, operation.id);

    return {
      id: operation.id,
      type: operation.type,
      state: operation.state,
      assetId: operation.assetId,
      walletId: operation.walletId,
      amount: operation.amount,
      operationReference: operation.operationReference,
      requiredApprovals: operation.requiredApprovals,
      failureCode: operation.failureCode,
      failureReason: operation.failureReason,
      correlationId: operation.correlationId,
      createdAt: operation.createdAt.toISOString(),
      stateUpdatedAt: operation.stateUpdatedAt.toISOString(),
      transactionHash: attempts.find((attempt) => attempt.transactionHash !== null)
        ?.transactionHash ?? null,
      history: history.map((entry) => ({ state: entry.state, at: entry.at.toISOString() })),
      // Signed transaction bytes are deliberately never exposed through the API.
      transactionAttempts: attempts.map((attempt) => ({
        id: attempt.id,
        purpose: attempt.purpose,
        status: attempt.status,
        nonce: attempt.nonce,
        transactionHash: attempt.transactionHash,
        blockNumber: attempt.blockNumber,
        receiptStatus: attempt.receiptStatus,
        broadcastAttempts: attempt.broadcastAttempts,
        errorCode: attempt.errorCode,
      })),
      reconciliation: observations.map((observation) => ({
        kind: observation.kind,
        matched: observation.matched,
        severity: observation.severity,
        status: observation.status,
        expected: observation.expected,
        actual: observation.actual,
        detail: observation.detail,
        observedAt: observation.observedAt.toISOString(),
      })),
    };
  });

  app.get('/v1/audit-events', { onRequest: authenticate }, async (request) => {
    const query = auditQuerySchema.parse(request.query);
    const page = await container.audit.query(request.ctx, query);
    return {
      events: page.events.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        actorType: event.actorType,
        actorId: event.actorId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        operationId: event.operationId,
        correlationId: event.correlationId,
        metadata: event.metadata,
      })),
      nextCursor: page.nextCursor,
    };
  });

  return app;
}

async function checkReadiness(probe: () => Promise<unknown>): Promise<'ok' | 'error'> {
  return probe()
    .then(() => 'ok' as const)
    .catch(() => 'error' as const);
}

function serializeAsset(asset: AssetRecord) {
  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    supplyCap: asset.supplyCap,
    chainId: asset.chainId,
    contractAddress: asset.contractAddress,
    deploymentTxHash: asset.deploymentTxHash,
    status: asset.status,
    policyVersion: asset.policyVersion,
    createdAt: asset.createdAt.toISOString(),
  };
}

function serializeWallet(wallet: WalletRecord) {
  return {
    id: wallet.id,
    address: wallet.address,
    chainId: wallet.chainId,
    label: wallet.label,
    investorReference: wallet.investorReference,
    status: wallet.status,
    createdAt: wallet.createdAt.toISOString(),
  };
}
