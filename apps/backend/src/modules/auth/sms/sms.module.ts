import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../../config/app.config.js';
import { SmsProviderName } from '../../../config/env.validation.js';
import { DevSmsProvider } from './dev-sms.provider.js';
import { DisabledSmsProvider } from './disabled-sms.provider.js';
import { SmsProvider } from './sms-provider.js';

/**
 * Chooses the SMS adapter from SMS_PROVIDER. To add a real provider:
 * 1. implement `SmsProvider` in this folder (credentials from env vars),
 * 2. add its name to `SmsProviderName` and the switch below,
 * 3. document its env vars in `.env.example`.
 */
@Module({
  providers: [
    DevSmsProvider,
    DisabledSmsProvider,
    {
      provide: SmsProvider,
      inject: [ConfigService, DevSmsProvider, DisabledSmsProvider],
      useFactory: (config: ConfigService, dev: DevSmsProvider, disabled: DisabledSmsProvider): SmsProvider => {
        const app = config.getOrThrow<AppConfig>(APP_CONFIG);
        switch (app.auth.smsProvider) {
          case SmsProviderName.Dev:
            // Second line of defence next to env validation.
            if (app.isProduction) throw new Error('The dev SMS provider must not be used in production');
            return dev;
          case SmsProviderName.Disabled:
          default:
            return disabled;
        }
      },
    },
  ],
  exports: [SmsProvider],
})
export class SmsModule {}
