import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/testing.dart';

void main() {
  Future<TestHsClient> signedIn({bool before = false, String? locale}) async {
    final kit = TestHsClient();
    if (before && locale != null) await kit.client.auth.syncLocale(locale);
    await kit.client.auth.sendCode('+966501234567');
    await kit.client.auth.submitCode('123456');
    return kit;
  }

  test('the language is sent at once when signed in', () async {
    final kit = await signedIn();
    await kit.client.auth.syncLocale('EN');
    expect(kit.api.lastLocale, 'EN');
    await kit.client.auth.syncLocale('AR');
    expect(kit.api.lastLocale, 'AR');
  });

  test('a language chosen before sign-in is sent as soon as the person signs in', () async {
    final kit = await signedIn(before: true, locale: 'EN');
    await Future<void>.delayed(Duration.zero);
    expect(kit.api.lastLocale, 'EN');
  });

  test('nothing is sent while signed out, and a failing server never raises', () async {
    final kit = TestHsClient();
    await kit.client.auth.syncLocale('EN');
    expect(kit.api.calls, isNot(contains('setLocale')));
  });

  test('the worker photo link is the server\'s answer, or null when there is none', () async {
    final kit = await signedIn();
    expect(await kit.client.auth.workerPhotoUrl(), isNull);
    kit.api.photoUrlResult = 'https://files.example/me.jpg';
    expect(await kit.client.auth.workerPhotoUrl(), 'https://files.example/me.jpg');
  });
}
