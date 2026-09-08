import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Container } from '../platform/container.js';
import { normalizeError } from './errors.js';
import { DevJwtAuthenticator } from '../platform/auth/jwt.js';
import { findUserBySubject, toActor } from '../db/repositories/user-repository.js';
import { UnauthorizedError, AppError, ErrorCode, NotFoundError } from '../domain/errors.js';
import type { RequestContext } from '../modules/context.js';
import { listAttemptsForOperation, listObservations } from '../db/repositories/transaction-repository.js';

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
 * HTTP transport.
 *
 * Handlers only parse input, call one application service and shape the response. All
 * authorization, state and persistence decisions live in the services, so the same rules
 * apply to the worker and the demo script.
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

  // --- health & metrics --------------------------------------------------

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    await container.db
      .execute('SELECT 1')
      .then(() => (checks['postgres'] = 'ok'))
      .catch(() => (checks['postgres'] = 'error'));
    await container.redis
      .ping()
      .then(() => (checks['redis'] = 'ok'))
      .catch(() => (checks['redis'] = 'error'));
    await container.gateway
      .getChainIdentity()
      .then(() => (checks['evm'] = 'ok'))
      .catch(() => (checks['evm'] = 'error'));

    const ready = Object.values(checks).every((value) => value === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });

  app.get('/metrics', async (_request, reply) => {
    if (!container.config.METRICS_ENABLED) return reply.status(404).send();
    return reply
      .header('content-type', container.metrics.contentType())
      .send(await container.metrics.render());
  });

  // --- assets ------------------------------------------------------------

  app.post('/v1/assets', { onRequest: authenticate }, async (request, reply) => {
    const body = createAssetSchema.parse(request.body);
    const asset = await container.assets.createAsset(request.ctx, body);
    return reply.status(201).send(serializeAsset(asset));
  });

  app.get('/v1/assets/:assetId', { onRequest: authenticate }, async (request) => {
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    return serializeAsset(await container.assets.getAsset(request.ctx, assetId));
  });

  // --- wallets -----------------------------------------------------------

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
      const decision = await container.compliance.recordDecision(request.ctx, {
        walletId,
        ...body,
      });
      return reply.status(201).send({
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
      });
    },
  );

  // --- mints -------------------------------------------------------------

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

  // --- approvals ---------------------------------------------------------

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

  // --- operations --------------------------------------------------------

  app.get('/v1/operations/:operationId', { onRequest: authenticate }, async (request) => {
    const { operationId } = z.object({ operationId: z.string().uuid() }).parse(request.params);
    const operation = await container.mints.getOperation(request.ctx, operationId);
    if (operation === null) throw new NotFoundError('operation', operationId);

    const attempts = await listAttemptsForOperation(container.db, operation.id);
    const observations = await listObservations(container.db, operation.id);

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
        expected: observation.expected,
        actual: observation.actual,
        observedAt: observation.observedAt.toISOString(),
      })),
    };
  });

  // --- audit -------------------------------------------------------------

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

function serializeAsset(asset: {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  supplyCap: string;
  chainId: number;
  contractAddress: string | null;
  deploymentTxHash: string | null;
  status: string;
  policyVersion: number;
  createdAt: Date;
}) {
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

function serializeWallet(wallet: {
  id: string;
  address: string;
  chainId: number;
  label: string | null;
  investorReference: string;
  status: string;
  createdAt: Date;
}) {
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
