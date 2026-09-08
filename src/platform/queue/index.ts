import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';

export const MINT_QUEUE = 'mint-operations';

/** BullMQ carries identifiers only; PostgreSQL holds the financial truth. */
export interface MintJobData {
  readonly operationId: string;
  readonly outboxId: string | null;
  readonly correlationId: string;
}

export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createMintQueue(connection: ConnectionOptions, prefix: string): Queue<MintJobData> {
  return new Queue<MintJobData>(MINT_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  });
}

export function createMintWorker(
  connection: ConnectionOptions,
  prefix: string,
  concurrency: number,
  processor: Processor<MintJobData>,
): Worker<MintJobData> {
  return new Worker<MintJobData>(MINT_QUEUE, processor, { connection, prefix, concurrency });
}
