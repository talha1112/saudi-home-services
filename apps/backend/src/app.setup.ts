import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js';
import type { AppConfig } from './config/app.config.js';
import { RealtimeIoAdapter } from './modules/realtime/realtime-io.adapter.js';

/**
 * Applies everything that makes the app behave like the real service. Shared by
 * `main.ts` and the e2e tests so both exercise identical wiring.
 */
export function configureApp(app: INestApplication, config: AppConfig): void {
  if (config.trustProxyHops > 0) {
    // Only trust X-Forwarded-For when a known number of proxies sits in front (rate limits key on the client IP).
    app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxyHops);
  }
  // Socket.IO (namespace /realtime). Authentication happens in the gateway's handshake middleware.
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, config));
  app.setGlobalPrefix(config.apiPrefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: config.defaultVersion });

  // Swagger is registered before helmet so its UI keeps working; the API itself is covered by helmet.
  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Home Services API')
        .setDescription('REST API for the Saudi home-maintenance marketplace.')
        .setVersion(`v${config.defaultVersion}`)
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(`${config.apiPrefix}/docs`, app, document, { jsonDocumentUrl: `${config.apiPrefix}/docs-json` });
  }

  app.use(helmet());

  if (config.corsOrigins.length > 0) {
    app.enableCors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      credentials: true,
      maxAge: 600,
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TimeoutInterceptor(config.requestTimeoutMs));
  app.enableShutdownHooks();
}
