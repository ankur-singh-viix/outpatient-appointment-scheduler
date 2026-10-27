import { INestApplication, RequestMethod } from '@nestjs/common';
import { loadConfig } from './config.js';

/**
 * Shared by main.ts and the e2e tests so both run the app the same way.
 * Request validation is done per route with Zod (see common/zod-validation.pipe.ts).
 */
export function configureApp(app: INestApplication): void {
  // API routes live under /api; GET / keeps returning "Hello World!".
  app.setGlobalPrefix('api', { exclude: [{ path: '/', method: RequestMethod.GET }] });
  app.enableCors({ origin: loadConfig().corsOrigins });
  app.enableShutdownHooks();
}
