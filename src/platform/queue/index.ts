import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';

export const OPERATION_QUEUE = 'chain-operations';

/** BullMQ carries identifiers only; PostgreSQL holds the financial truth. */
export interface OperationJobData {
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

export function createOperationQueue(
  connection: ConnectionOptions,
  prefix: string,
): Queue<OperationJobData> {
  return new Queue<OperationJobData>(OPERATION_QUEUE, {
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

export function createOperationWorker(
  connection: ConnectionOptions,
  prefix: string,
  concurrency: number,
  processor: Processor<OperationJobData>,
): Worker<OperationJobData> {
  return new Worker<OperationJobData>(OPERATION_QUEUE, processor, {
    connection,
    prefix,
    concurrency,
  });
}
