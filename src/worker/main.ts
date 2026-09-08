import { createContainer } from '../platform/container.js';
import { startWorkerRuntime } from './runtime.js';

const container = await createContainer({ serviceName: 'worker', migrate: true });
const runtime = startWorkerRuntime(container);

container.logger.info({ workerId: runtime.workerId }, 'worker started');

const shutdown = async (signal: string): Promise<void> => {
  container.logger.info({ signal }, 'shutting down worker');
  await runtime.stop();
  await container.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
