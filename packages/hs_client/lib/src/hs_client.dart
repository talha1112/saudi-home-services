import 'api_client.dart';
import 'auth_controller.dart';
import 'models.dart';
import 'phone_auth_gateway.dart';
import 'push_service.dart';
import 'storage.dart';
import 'worker_onboarding_controller.dart';

/// Everything an app needs, wired together: the API, the sign-in controller and push registration.
///
/// Firebase must be initialised first (`Firebase.initializeApp`) before [HsClient.firebase] is used.
class HsClient {
  HsClient({required this.api, required this.auth, required this.push, required this.store, WorkerOnboardingController? onboarding})
    : onboarding = onboarding ?? WorkerOnboardingController(api: api, auth: auth) {
    auth.onSignedIn = push.start;
    auth.onBeforeSignOut = push.stop;
    auth.onSessionLost = push.abandon;
  }

  /// The production wiring: real HTTP, platform secure storage, Firebase phone auth and Firebase Cloud Messaging.
  factory HsClient.firebase(HsConfig config) {
    final api = HsApi(baseUrl: config.baseUrl, allowCleartextUploads: config.allowCleartextUploads);
    final store = SessionStore(SecureKeyValueStore());
    final auth = AuthController(api: api, store: store, phone: FirebasePhoneAuthGateway(), kind: config.kind);
    final push = PushService(api: api, gateway: FirebasePushGateway(), auth: auth, store: store);
    return HsClient(api: api, auth: auth, push: push, store: store);
  }

  final HsApi api;
  final AuthController auth;
  final PushService push;

  /// Worker application and verification (used by the worker app only).
  final WorkerOnboardingController onboarding;
  final SessionStore store;

  void dispose() {
    onboarding.dispose();
    auth.dispose();
    api.close();
  }
}
