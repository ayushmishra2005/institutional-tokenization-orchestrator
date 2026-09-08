import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import type { Container } from '../platform/container.js';
import { createOperationWorker, type OperationJobData } from '../platform/queue/index.js';
import { countOperationsByState } from '../db/repositories/operation-repository.js';
import { countOpenFindingsBySeverity } from '../db/repositories/transaction-repository.js';

export interface WorkerReadiness {
  readonly ready: boolean;
  readonly checks: Record<'postgres' | 'redis' | 'evm', 'ok' | 'error'>;
}

export interface WorkerRuntime {
  readonly workerId: string;
  readonly worker: Worker<OperationJobData>;
  /**
   * Unlike the API, the worker cannot do any of its work without all three: it reads
   * durable state from PostgreSQL, takes jobs from Redis and writes to the chain.
   */
  readiness(): Promise<WorkerReadiness>;
  stop(): Promise<void>;
}

/**
 * Outbox dispatch, BullMQ consumption and the periodic recovery sweep. The queue callback
 * holds no business logic: it resolves an operation id and hands off to the executor.
 */
export function startWorkerRuntime(container: Container): WorkerRuntime {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const logger = container.logger.child({ workerId });

  container.dispatcher.start();

  const worker = createOperationWorker(
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
        const result = await container.operationExecutor.execute(job.data.operationId, workerId);
        container.metrics.queueJobs.inc({ queue: 'chain-operations', result: result.kind });
        jobLogger.info({ result: result.kind }, 'operation job processed');
        return result;
      } catch (error) {
        container.metrics.queueJobs.inc({ queue: 'chain-operations', result: 'error' });
        jobLogger.error({ err: error }, 'operation job threw');
        throw error;
      } finally {
        stop();
      }
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, operationId: job?.data.operationId, err: error }, 'operation job failed');
  });

  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const summary = await container.recovery.sweep();
        const openFindings = await countOpenFindingsBySeverity(container.db);
        if (summary.requeued + summary.rebroadcast + summary.resolved + summary.failed > 0) {
          logger.warn({ summary }, 'recovery sweep took action');
        }
        for (const entry of await countOperationsByState(container.db)) {
          container.metrics.operationsInState.set({ state: entry.state }, entry.count);
        }
        for (const severity of ['INFO', 'WARNING', 'CRITICAL']) {
          const found = openFindings.find((entry) => entry.severity === severity);
          container.metrics.openReconciliationFindings.set({ severity }, found?.count ?? 0);
        }
      } catch (error) {
        logger.error({ err: error }, 'recovery sweep failed');
      }
    })();
  }, container.config.RECOVERY_SWEEP_INTERVAL_MS);

  return {
    workerId,
    worker,
    readiness: async () => {
      const [postgres, redis, evm] = await Promise.all([
        probe(() => container.db.execute('SELECT 1')),
        probe(() => container.redis.ping()),
        probe(() => container.gateway.getChainIdentity()),
      ]);
      const checks = { postgres, redis, evm };
      return { ready: Object.values(checks).every((value) => value === 'ok'), checks };
    },
    stop: async () => {
      clearInterval(sweepTimer);
      await worker.close();
      await container.dispatcher.stop();
    },
  };
}

async function probe(check: () => Promise<unknown>): Promise<'ok' | 'error'> {
  return check()
    .then(() => 'ok' as const)
    .catch(() => 'error' as const);
}
