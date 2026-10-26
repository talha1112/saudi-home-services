import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import appConfig, { APP_CONFIG, type AppConfig } from './config/app.config.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AdminConsoleModule } from './modules/admin-console/admin-console.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { DisputesModule } from './modules/disputes/disputes.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OffersModule } from './modules/offers/offers.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { SupportModule } from './modules/support/support.module.js';
import { WorkersModule } from './modules/workers/workers.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      // Real secrets come from the process environment; .env is for local development only.
      envFilePath: ['.env.local', '.env'],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const app = config.getOrThrow<AppConfig>(APP_CONFIG);
        return {
          pinoHttp: {
            level: app.logLevel,
            // Honour an upstream request id, otherwise create one.
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id'];
              const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false },
            transport: app.isProduction
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true, colorize: true } },
          },
        };
      },
    }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    ProfilesModule,
    CatalogModule,
    WorkersModule,
    PricingModule,
    BookingsModule,
    PaymentsModule,
    RealtimeModule,
    SupportModule,
    NotificationsModule,
    AdminModule,
    AdminConsoleModule,
    DisputesModule,
    ReviewsModule,
    ReportsModule,
    OffersModule,
  ],
})
export class AppModule {}
