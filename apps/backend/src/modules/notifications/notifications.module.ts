import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { DeviceTokensService } from './device-tokens.service.js';
import { NotificationDeliveryService } from './notification-delivery.service.js';
import { DevicesController, NotificationsController } from './notifications.controllers.js';
import { NotificationsService } from './notifications.service.js';
import { DisabledPushProvider, MockPushProvider, PushProvider } from './push/push-provider.js';
import { selectPushProvider } from './push/push-provider.factory.js';

/**
 * In-app notifications, the push delivery pipeline and device-token registration.
 * Provider: PUSH_PROVIDER = disabled (default, deliveries are UNSUPPORTED) | fcm (Firebase Cloud Messaging, explicit opt-in) | mock (test
 * double, refused in production). Selection lives in `selectPushProvider`. An APNs/HMS adapter would implement `PushProvider` the same way.
 */
@Module({
  controllers: [NotificationsController, DevicesController],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    DeviceTokensService,
    DisabledPushProvider,
    MockPushProvider,
    {
      provide: PushProvider,
      inject: [ConfigService, DisabledPushProvider, MockPushProvider],
      useFactory: (config: ConfigService, disabled: DisabledPushProvider, mock: MockPushProvider): PushProvider => {
        return selectPushProvider(config.getOrThrow<AppConfig>(APP_CONFIG), disabled, mock);
      },
    },
  ],
  exports: [NotificationsService, NotificationDeliveryService],
})
export class NotificationsModule {}
