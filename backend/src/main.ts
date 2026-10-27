import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadEnvFileIfPresent } from './config.js';

async function bootstrap() {
  loadEnvFileIfPresent();
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
