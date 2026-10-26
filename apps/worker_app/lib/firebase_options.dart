// Firebase client configuration for this app, taken from the Firebase project saudi-home-services-b8ca5 (the app registrations
// "Worker app"). Firebase is used for phone sign-in (Authentication) and push (Cloud Messaging) ONLY. These values identify the app to Firebase; they are not secrets. In the Google Cloud console, restrict the API keys
// to this app (package name + signing certificate on Android, bundle ID on iOS). The backend's service-account key is NOT here and
// must never be in a mobile app.
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform;

abstract final class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        throw UnsupportedError(
          'Firebase is configured for Android and iOS only.',
        );
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyDqWPWfNCMA7eFFmy1FbZVQmTPTkXzUAzE',
    appId: '1:240836234895:android:c546983230008ae0a5eafa',
    messagingSenderId: '240836234895',
    projectId: 'saudi-home-services-b8ca5',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyDt5fOxtsA2fWrpb3thKT_9fDAheDlSu2s',
    appId: '1:240836234895:ios:02cabe3f217578dda5eafa',
    messagingSenderId: '240836234895',
    projectId: 'saudi-home-services-b8ca5',
    iosBundleId: 'com.saudihomeservices.workerApp',
  );
}
