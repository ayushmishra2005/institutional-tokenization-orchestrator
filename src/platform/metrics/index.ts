import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus-compatible metrics. A dedicated Registry (rather than the global default)
 * keeps test runs isolated from each other.
 */
export class Metrics {
  readonly registry: Registry;

  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>;

  readonly operationTransitions: Counter<'from' | 'to' | 'type'>;
  readonly operationsInState: Gauge<'state'>;
  readonly operationsFailed: Counter<'reason'>;
  readonly broadcastUnknownTotal: Counter<string>;
  readonly transactionConfirmations: Counter<'outcome'>;

  readonly outboxBacklog: Gauge<'status'>;
  readonly outboxDispatched: Counter<'topic' | 'result'>;

  readonly queueJobs: Counter<'queue' | 'result'>;
  readonly workerProcessingDuration: Histogram<'job'>;

  readonly rpcRequests: Counter<'method' | 'result'>;
  readonly rpcDuration: Histogram<'method'>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new Histogram({
      name: 'ito_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'ito_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [this.registry],
    });

    this.operationTransitions = new Counter({
      name: 'ito_operation_transitions_total',
      help: 'Operation state machine transitions',
      labelNames: ['from', 'to', 'type'] as const,
      registers: [this.registry],
    });

    this.operationsInState = new Gauge({
      name: 'ito_operations_in_state',
      help: 'Current number of operations per state',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });

    this.operationsFailed = new Counter({
      name: 'ito_operations_failed_total',
      help: 'Operations that reached a failure state',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.broadcastUnknownTotal = new Counter({
      name: 'ito_broadcast_unknown_total',
      help: 'Broadcast attempts whose outcome could not be determined',
      registers: [this.registry],
    });

    this.transactionConfirmations = new Counter({
      name: 'ito_transaction_confirmations_total',
      help: 'Confirmed transactions by receipt outcome',
      labelNames: ['outcome'] as const,
      registers: [this.registry],
    });

    this.outboxBacklog = new Gauge({
      name: 'ito_outbox_backlog',
      help: 'Outbox rows by status',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.outboxDispatched = new Counter({
      name: 'ito_outbox_dispatched_total',
      help: 'Outbox rows dispatched to the queue',
      labelNames: ['topic', 'result'] as const,
      registers: [this.registry],
    });

    this.queueJobs = new Counter({
      name: 'ito_queue_jobs_total',
      help: 'BullMQ jobs processed',
      labelNames: ['queue', 'result'] as const,
      registers: [this.registry],
    });

    this.workerProcessingDuration = new Histogram({
      name: 'ito_worker_processing_duration_seconds',
      help: 'Worker job processing duration in seconds',
      labelNames: ['job'] as const,
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [this.registry],
    });

    this.rpcRequests = new Counter({
      name: 'ito_rpc_requests_total',
      help: 'EVM RPC calls by gateway method',
      labelNames: ['method', 'result'] as const,
      registers: [this.registry],
    });

    this.rpcDuration = new Histogram({
      name: 'ito_rpc_duration_seconds',
      help: 'EVM RPC call duration in seconds',
      labelNames: ['method'] as const,
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}

export function createMetrics(): Metrics {
  return new Metrics();
}
