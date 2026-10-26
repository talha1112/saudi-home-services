import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_CONFIG, type AppConfig } from './config/app.config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Payment webhooks are signature-checked over the exact bytes received, so keep the raw body.
    rawBody: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG);
  configureApp(app, config);

  await app.listen(config.port, config.host);

  const base = `${config.apiPrefix}/v${config.defaultVersion}`;
  logger.log(`API listening on http://${config.host}:${config.port}/${base} (${config.env})`);
  if (config.swaggerEnabled) {
    logger.log(`Swagger UI at http://${config.host}:${config.port}/${config.apiPrefix}/docs`);
  }
}

void bootstrap();
