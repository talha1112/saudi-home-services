import { Injectable } from '@nestjs/common';
import { unavailable } from '../../../common/errors/api-error.js';
import { SmsMessage, SmsProvider } from './sms-provider.js';

/** Used when no real provider is configured (the production default). Fails closed. */
@Injectable()
export class DisabledSmsProvider extends SmsProvider {
  async send(_message: SmsMessage): Promise<void> {
    throw unavailable('SMS_PROVIDER_NOT_CONFIGURED', 'Phone verification is temporarily unavailable');
  }
}
