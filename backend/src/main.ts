import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { announceEmailMode } from './auth/email-sender.js';
import { loadConfig, loadEnvFileIfPresent } from './config.js';
import { missingSchemaGuards } from './database/schema-guards.js';

async function bootstrap() {
  loadEnvFileIfPresent();
  announceEmailMode(loadConfig());
  const app = await NestFactory.create(AppModule, { rawBody: true }); // rawBody: Razorpay webhook signatures cover the exact bytes received
  configureApp(app);
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  // Say so loudly if a database protection against double booking is missing (it is added conditionally by migration 007).
  try {
    for (const guard of await missingSchemaGuards(app.get(DataSource))) new Logger('Schema').warn(`Database guard ${guard.name} is missing: ${guard.consequence}.`);
  } catch {
    // The check is advisory; never stop the server for it.
  }
}
await bootstrap();
