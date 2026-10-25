import { buildApp } from './web/app.js';

const port = Number(process.env.API_PORT ?? 3000);
const app = await buildApp();

try {
  await app.listen({ host: '0.0.0.0', port });
  app.log.info({ port }, 'Flowboard API listening');
} catch (error) {
  app.log.error(error, 'Failed to start API');
  process.exitCode = 1;
}
