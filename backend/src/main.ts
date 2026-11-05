import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadEnvFileIfPresent } from './config.js';

async function bootstrap() {
  loadEnvFileIfPresent();
  const app = await NestFactory.create(AppModule, { rawBody: true }); // rawBody: Razorpay webhook signatures cover the exact bytes received
  configureApp(app);
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
}
await bootstrap();
