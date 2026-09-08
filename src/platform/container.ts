import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createDbHandle, type Database, type DbHandle } from '../db/pool.js';
import { runMigrations } from '../db/migrator.js';
import { getConfig, type AppConfig } from './config/index.js';
import { createLogger, type Logger } from './logging/index.js';
import { createMetrics, type Metrics } from './metrics/index.js';
import { DevJwtAuthenticator } from './auth/jwt.js';
import { createMintQueue, createRedisConnection, type MintJobData } from './queue/index.js';
import { ViemEvmGateway } from '../adapters/evm/viem-evm-gateway.js';
import { LocalSignerProvider } from '../adapters/signer/local-signer-provider.js';
import { MockComplianceProvider } from '../adapters/compliance/mock-compliance-provider.js';
import { ChainWriter } from '../modules/transactions/chain-writer.js';
import { ReconciliationService } from '../modules/transactions/reconciliation-service.js';
import { RecoveryService } from '../modules/transactions/recovery-service.js';
import { AssetService } from '../modules/assets/asset-service.js';
import { WalletService } from '../modules/wallets/wallet-service.js';
import { ComplianceService } from '../modules/compliance/compliance-service.js';
import { IdempotencyService } from '../modules/idempotency/idempotency-service.js';
import { MintService } from '../modules/operations/mint-service.js';
import { MintExecutor } from '../modules/operations/mint-executor.js';
import { ApprovalService } from '../modules/approvals/approval-service.js';
import { AuditService } from '../modules/audit/audit-service.js';
import { OutboxDispatcher } from '../modules/outbox/outbox-dispatcher.js';
import type { ConfirmationPolicy } from '../modules/transactions/confirmation.js';
import type { EvmGateway } from '../ports/evm-gateway.js';
import type { SignerProvider } from '../ports/signer-provider.js';
import type { ComplianceProvider } from '../ports/compliance-provider.js';

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly db: Database;
  readonly dbHandle: DbHandle;
  readonly redis: IORedis;
  readonly queue: Queue<MintJobData>;
  readonly auth: DevJwtAuthenticator;
  readonly gateway: EvmGateway;
  readonly signer: SignerProvider;
  readonly complianceProvider: ComplianceProvider;
  readonly chainWriter: ChainWriter;
  readonly confirmation: ConfirmationPolicy;
  readonly assets: AssetService;
  readonly wallets: WalletService;
  readonly compliance: ComplianceService;
  readonly mints: MintService;
  readonly mintExecutor: MintExecutor;
  readonly approvals: ApprovalService;
  readonly audit: AuditService;
  readonly dispatcher: OutboxDispatcher;
  readonly recovery: RecoveryService;
  close(): Promise<void>;
}

export interface ContainerOptions {
  readonly serviceName: string;
  readonly config?: AppConfig;
  /** Runs pending migrations during construction. Convenient for local dev and tests. */
  readonly migrate?: boolean;
  readonly complianceProvider?: ComplianceProvider;
  readonly signer?: SignerProvider;
  readonly gateway?: EvmGateway;
}

/**
 * Composition root.
 *
 * Every dependency is constructed here and injected by constructor, so no module reaches
 * for a global and any adapter can be swapped in tests without monkey-patching.
 */
export async function createContainer(options: ContainerOptions): Promise<Container> {
  const config = options.config ?? getConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: options.serviceName });
  const metrics = createMetrics();

  const dbHandle = createDbHandle({
    url: config.DATABASE_URL,
    maxConnections: config.DATABASE_POOL_MAX,
  });
  if (options.migrate === true) await runMigrations(dbHandle.pool);

  const redis = createRedisConnection(config.REDIS_URL);
  const queue = createMintQueue(redis, config.QUEUE_PREFIX);

  const auth = new DevJwtAuthenticator({
    secret: config.JWT_SECRET,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });

  const gateway =
    options.gateway ??
    new ViemEvmGateway({ rpcUrl: config.EVM_RPC_URL, chainId: config.EVM_CHAIN_ID, metrics });

  const signer =
    options.signer ??
    new LocalSignerProvider({
      privateKey: config.LOCAL_SIGNER_PRIVATE_KEY as `0x${string}`,
      expectedAddress: config.LOCAL_SIGNER_ADDRESS as `0x${string}`,
      chainId: config.EVM_CHAIN_ID,
    });

  const complianceProvider = options.complianceProvider ?? new MockComplianceProvider();

  const confirmation: ConfirmationPolicy = {
    confirmations: config.EVM_CONFIRMATIONS,
    timeoutMs: config.EVM_RECEIPT_TIMEOUT_MS,
    pollIntervalMs: 200,
  };

  const chainWriter = new ChainWriter({
    db: dbHandle.db,
    gateway,
    signer,
    chainId: config.EVM_CHAIN_ID,
    metrics,
    logger,
  });

  const assets = new AssetService({
    db: dbHandle.db,
    gateway,
    signer,
    chainWriter,
    chainId: config.EVM_CHAIN_ID,
    confirmation,
  });
  const wallets = new WalletService(dbHandle.db, config.EVM_CHAIN_ID);
  const compliance = new ComplianceService({
    db: dbHandle.db,
    provider: complianceProvider,
    gateway,
    chainWriter,
    confirmation,
  });
  const idempotency = new IdempotencyService(dbHandle.db);
  const mints = new MintService(dbHandle.db, idempotency, assets);
  const approvals = new ApprovalService(dbHandle.db, metrics);
  const audit = new AuditService(dbHandle.db);

  const reconciliation = new ReconciliationService(
    dbHandle.db,
    gateway,
    config.EVM_CHAIN_ID,
    logger,
  );
  const mintExecutor = new MintExecutor({
    db: dbHandle.db,
    gateway,
    chainWriter,
    compliance,
    reconciliation,
    confirmation,
    chainId: config.EVM_CHAIN_ID,
    mintDeadlineSeconds: config.MINT_DEADLINE_SECONDS,
    metrics,
    logger,
  });

  const dispatcher = new OutboxDispatcher(dbHandle.db, queue, metrics, logger, {
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
  });

  const recovery = new RecoveryService({
    db: dbHandle.db,
    gateway,
    chainWriter,
    executor: mintExecutor,
    queue,
    metrics,
    logger,
    options: { staleAfterMs: config.RECOVERY_STALE_AFTER_MS, batchSize: 50 },
  });

  return {
    config,
    logger,
    metrics,
    db: dbHandle.db,
    dbHandle,
    redis,
    queue,
    auth,
    gateway,
    signer,
    complianceProvider,
    chainWriter,
    confirmation,
    assets,
    wallets,
    compliance,
    mints,
    mintExecutor,
    approvals,
    audit,
    dispatcher,
    recovery,
    close: async () => {
      await dispatcher.stop();
      await queue.close();
      redis.disconnect();
      await dbHandle.close();
    },
  };
}
