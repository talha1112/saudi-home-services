import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Firebase is used for phone sign-in and push notifications ONLY. This fails if another Firebase product (Analytics, Firestore, Storage,
/// Crashlytics, App Check, ...) is added to the shared package or to either app, so that choice cannot drift unnoticed.
void main() {
  const allowed = {'firebase_core', 'firebase_auth', 'firebase_messaging'};

  test('only Firebase Core, Authentication (phone) and Cloud Messaging are used', () {
    final files = [File('pubspec.yaml'), File('../../apps/customer_app/pubspec.yaml'), File('../../apps/worker_app/pubspec.yaml')];
    for (final file in files) {
      expect(file.existsSync(), isTrue, reason: file.path);
      final used = RegExp(
        r'^\s{2}(firebase_\w+|cloud_firestore|google_sign_in|sign_in_with_apple)\s*:',
        multiLine: true,
      ).allMatches(file.readAsStringSync()).map((m) => m.group(1)!).toSet();
      expect(used.difference(allowed), isEmpty, reason: '${file.path} uses ${used.difference(allowed)}');
    }
  });

  test('no other sign-in method is wired in the shared package', () {
    final sources = Directory('lib').listSync(recursive: true).whereType<File>().map((f) => f.readAsStringSync()).join('\n');
    expect(sources, isNot(contains('GoogleSignIn')));
    expect(sources, isNot(contains('signInWithEmailAndPassword')));
    expect(sources, isNot(contains('signInAnonymously')));
    expect(sources, isNot(contains('FirebaseAnalytics')));
  });
}
