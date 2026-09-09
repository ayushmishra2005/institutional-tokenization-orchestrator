import { z } from 'zod';

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');

const hexPrivateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte private key');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().url(),
  QUEUE_PREFIX: z.string().min(1).default('ito'),

  EVM_RPC_URL: z.string().url(),
  EVM_CHAIN_ID: z.coerce.number().int().positive(),
  /** Confirmations required before an included transaction is treated as final. */
  EVM_CONFIRMATIONS: z.coerce.number().int().min(1).default(2),
  EVM_RECEIPT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Seconds added to `block.timestamp` when building a mint deadline. */
  SIGNER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),
  MINT_DEADLINE_SECONDS: z.coerce.number().int().min(30).default(900),

  JWT_SECRET: z.string().min(16, 'JWT secret must be at least 16 characters'),
  JWT_ISSUER: z.string().default('ito-local'),
  JWT_AUDIENCE: z.string().default('ito-api'),

  /**
   * DEVELOPMENT ONLY. The local signer adapter holds this key in process memory.
   * It is never persisted, enqueued, logged or returned by the API.
   */
  LOCAL_SIGNER_PRIVATE_KEY: hexPrivateKey,
  LOCAL_SIGNER_ADDRESS: hexAddress,

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  RECOVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(200).default(5_000),
  /** An operation stuck mid-flight for longer than this is picked up by the sweep. */
  RECOVERY_STALE_AFTER_MS: z.coerce.number().int().min(200).default(15_000),

  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates process configuration up-front so a misconfigured deployment fails at
 * startup rather than midway through a financial workflow.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  if (parsed.data.NODE_ENV === 'production') {
    throw new ConfigError([
      'NODE_ENV=production is refused: this reference implementation ships only development adapters',
    ]);
  }

  return Object.freeze(parsed.data);
}

let dotEnvLoaded = false;

/**
 * Loads `.env` into process.env if present. Existing environment variables win, so an
 * explicitly exported value always overrides the file.
 */
export function loadDotEnv(path = '.env'): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env file: rely entirely on the ambient environment.
  }
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached === undefined) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}
