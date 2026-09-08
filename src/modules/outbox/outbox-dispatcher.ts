import type { Queue } from 'bullmq';
import type { Database } from '../../db/pool.js';
import {
  claimPendingOutbox,
  countOutboxByStatus,
  markOutboxDispatched,
  OutboxTopic,
  rescheduleOutbox,
  type OutboxRecord,
} from '../../db/repositories/outbox-repository.js';
import type { MintJobData } from '../../platform/queue/index.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';

export interface OutboxDispatcherOptions {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly retryAfterMs?: number;
}

/**
 * Publishes committed outbox rows to BullMQ.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED so multiple dispatchers can run. Delivery
 * is at-least-once by construction: the row is marked dispatched only after the job is
 * accepted, and a crash in between simply republishes it. Duplicate delivery is harmless
 * because the worker claims the operation in PostgreSQL before doing anything.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly queue: Queue<MintJobData>,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: OutboxDispatcherOptions,
  ) {}

  start(): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.dispatchOnce();
      } catch (error) {
        this.logger.error({ err: error }, 'outbox dispatch cycle failed');
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.options.pollIntervalMs);
    };
    this.timer = setTimeout(() => void tick(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    // Let an in-flight cycle finish so it does not write after the pool closes.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Returns the number of rows successfully published. */
  async dispatchOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await this.db.transaction((tx) =>
        claimPendingOutbox(tx, { limit: this.options.batchSize }),
      );
      if (claimed.length === 0) {
        await this.reportBacklog();
        return 0;
      }

      const dispatched: string[] = [];
      for (const row of claimed) {
        try {
          await this.publish(row);
          dispatched.push(row.id);
          this.metrics.outboxDispatched.inc({ topic: row.topic, result: 'success' });
        } catch (error) {
          this.metrics.outboxDispatched.inc({ topic: row.topic, result: 'failure' });
          this.logger.error({ err: error, outboxId: row.id }, 'failed to publish outbox row');
          await rescheduleOutbox(this.db, {
            id: row.id,
            error: error instanceof Error ? error.message : 'unknown',
            retryAfterMs: this.options.retryAfterMs ?? 2000,
          });
        }
      }

      await markOutboxDispatched(this.db, dispatched);
      await this.reportBacklog();
      return dispatched.length;
    } finally {
      this.running = false;
    }
  }

  private async publish(row: OutboxRecord): Promise<void> {
    if (row.topic !== OutboxTopic.MINT_OPERATION_READY) {
      throw new Error(`unsupported outbox topic ${row.topic}`);
    }
    const payload = row.payload as { operationId?: string };
    if (typeof payload.operationId !== 'string') {
      throw new Error(`outbox row ${row.id} has no operationId`);
    }

    await this.queue.add(
      OutboxTopic.MINT_OPERATION_READY,
      {
        operationId: payload.operationId,
        outboxId: row.id,
        correlationId: row.correlationId,
      },
      // Deterministic job id collapses accidental duplicates within Redis' retention.
      // BullMQ forbids ':' in custom job ids.
      { jobId: `outbox-${row.id}` },
    );
  }

  private async reportBacklog(): Promise<void> {
    const counts = await countOutboxByStatus(this.db);
    for (const status of ['PENDING', 'DISPATCHED', 'FAILED']) {
      const found = counts.find((entry) => entry.status === status);
      this.metrics.outboxBacklog.set({ status }, found?.count ?? 0);
    }
  }
}
