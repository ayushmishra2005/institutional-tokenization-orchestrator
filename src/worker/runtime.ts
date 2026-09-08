import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import type { Container } from '../platform/container.js';
import { createMintWorker, type MintJobData } from '../platform/queue/index.js';
import { countOperationsByState } from '../db/repositories/operation-repository.js';

export interface WorkerRuntime {
  readonly workerId: string;
  readonly worker: Worker<MintJobData>;
  stop(): Promise<void>;
}

/**
 * Wires the asynchronous side: outbox dispatch, BullMQ consumption and the periodic
 * recovery sweep.
 *
 * The BullMQ callback contains no business logic. It resolves an operation id and hands
 * off to the executor, which reloads everything authoritative from PostgreSQL.
 */
export function startWorkerRuntime(container: Container): WorkerRuntime {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const logger = container.logger.child({ workerId });

  container.dispatcher.start();

  const worker = createMintWorker(
    container.redis,
    container.config.QUEUE_PREFIX,
    container.config.WORKER_CONCURRENCY,
    async (job) => {
      const stop = container.metrics.workerProcessingDuration.startTimer({ job: job.name });
      const jobLogger = logger.child({
        operationId: job.data.operationId,
        correlationId: job.data.correlationId,
        jobId: job.id,
      });
      try {
        const result = await container.mintExecutor.execute(job.data.operationId, workerId);
        container.metrics.queueJobs.inc({ queue: 'mint-operations', result: result.kind });
        jobLogger.info({ result: result.kind }, 'mint job processed');
        return result;
      } catch (error) {
        container.metrics.queueJobs.inc({ queue: 'mint-operations', result: 'error' });
        jobLogger.error({ err: error }, 'mint job threw');
        throw error;
      } finally {
        stop();
      }
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'mint job failed');
  });

  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const summary = await container.recovery.sweep();
        if (summary.requeued + summary.rebroadcast + summary.resolved + summary.failed > 0) {
          logger.warn({ summary }, 'recovery sweep took action');
        }
        const counts = await countOperationsByState(container.db);
        for (const entry of counts) {
          container.metrics.operationsInState.set({ state: entry.state }, entry.count);
        }
      } catch (error) {
        logger.error({ err: error }, 'recovery sweep failed');
      }
    })();
  }, container.config.RECOVERY_SWEEP_INTERVAL_MS);

  return {
    workerId,
    worker,
    stop: async () => {
      clearInterval(sweepTimer);
      await worker.close();
      await container.dispatcher.stop();
    },
  };
}
