import type { AppConfig } from '../../../config/app.config.js';
import { PushProviderMode } from '../../../config/env.validation.js';
import { FcmPushProvider } from './fcm-push-provider.js';
import type { DisabledPushProvider, MockPushProvider, PushProvider } from './push-provider.js';

/**
 * Chooses the push adapter from PUSH_PROVIDER. Disabled is the default and the fallback: nothing is sent unless `fcm` is chosen explicitly.
 * Second line of defence next to environment validation (which has already checked the settings an enabled provider needs).
 */
export function selectPushProvider(app: AppConfig, disabled: DisabledPushProvider, mock: MockPushProvider): PushProvider {
  switch (app.notifications.pushProvider) {
    case PushProviderMode.Mock:
      if (app.isProduction) throw new Error('The mock push provider must not be used in production');
      return mock;
    case PushProviderMode.Fcm: {
      const { fcm, serviceAccount } = app.firebase;
      if (!fcm.enabled || !fcm.projectId || !serviceAccount) throw new Error('PUSH_PROVIDER=fcm needs FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_BASE64');
      if (!app.notifications.deviceTokenKey) throw new Error('PUSH_PROVIDER=fcm needs DEVICE_TOKEN_ENCRYPTION_KEY');
      return new FcmPushProvider({ projectId: fcm.projectId, serviceAccount, dryRun: fcm.dryRun });
    }
    default:
      return disabled;
  }
}
