import { createContainer } from '../platform/container.js';
import { buildApp } from './app.js';

const container = await createContainer({ serviceName: 'api', migrate: true });
const app = await buildApp(container);

const shutdown = async (signal: string): Promise<void> => {
  container.logger.info({ signal }, 'shutting down api');
  await app.close();
  await container.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: container.config.API_HOST, port: container.config.API_PORT });
container.logger.info(
  { host: container.config.API_HOST, port: container.config.API_PORT },
  'api listening',
);
