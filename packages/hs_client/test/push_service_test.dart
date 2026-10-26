import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';

import 'package:hs_client/testing.dart';

class Rig {
  Rig({String platform = 'ANDROID', Duration limit = const Duration(seconds: 5)}) {
    controller = AuthController(api: api, store: store, phone: phone, kind: AppKind.customer, clock: clock.call, cleanupTimeout: limit);
    push = PushService(api: api, gateway: gateway, auth: controller, store: store, platform: () => platform, cleanupLimit: limit);
    controller.onSignedIn = push.start;
    controller.onBeforeSignOut = push.stop;
    controller.onSessionLost = push.abandon;
  }

  final api = FakeApi();
  final phone = FakePhone();
  final gateway = FakePush();
  final store = SessionStore(MemoryKeyValueStore());
  final clock = Clock();
  late final AuthController controller;
  late final PushService push;

  Future<void> signIn() async {
    api.signInResult = fakeSession(accessExpiresAt: clock.now.add(const Duration(minutes: 15)));
    await controller.sendCode('+966501234567');
    await controller.submitCode('123456');
  }
}

void main() {
  test('registers the FCM token for the signed-in account after sign-in, with the right platform, and keeps only the device id', () async {
    final r = Rig(platform: 'IOS');
    await r.signIn();
    expect(r.api.calls, contains('registerDevice'));
    expect(r.api.lastRegisteredToken, 'fcm-token-1');
    expect(r.api.lastRegisterPlatform, 'IOS');
    expect(await r.store.readDeviceId(), 'device-1');
    expect(r.push.permissionGranted, isTrue);
  });

  test('does nothing when notifications are not allowed or there is no token', () async {
    final denied = Rig();
    denied.gateway.permission = false;
    await denied.signIn();
    expect(denied.api.calls, isNot(contains('registerDevice')));
    expect(denied.push.permissionGranted, isFalse);
    expect(denied.controller.isSignedIn, isTrue);

    final none = Rig();
    none.gateway.token = null;
    await none.signIn();
    expect(none.api.calls, isNot(contains('registerDevice')));
  });

  test('starting twice registers once', () async {
    final r = Rig();
    await r.signIn();
    await r.push.start();
    await r.push.start();
    expect(r.api.calls.where((c) => c == 'registerDevice'), hasLength(1));
  });

  test('a rotated token is registered first and the previous registration revoked after', () async {
    final r = Rig();
    await r.signIn();
    r.api.registerResult = 'device-2';
    r.gateway.refresh.add('fcm-token-2');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(r.api.lastRegisteredToken, 'fcm-token-2');
    expect(r.api.revoked, ['device-1']);
    expect(await r.store.readDeviceId(), 'device-2');
    final order = r.api.calls.where((c) => c == 'registerDevice' || c == 'revokeDevice').toList();
    expect(order, ['registerDevice', 'registerDevice', 'revokeDevice']);
  });

  test('re-registering the same token (the backend answers with the same device) revokes nothing', () async {
    final r = Rig();
    await r.signIn();
    r.gateway.refresh.add('fcm-token-1');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(r.api.revoked, isEmpty);
  });

  test('sign-out revokes this device first, forgets the id and drops the FCM token', () async {
    final r = Rig();
    await r.signIn();
    await r.controller.signOut();
    expect(r.api.revoked, ['device-1']);
    expect(await r.store.readDeviceId(), isNull);
    expect(r.gateway.deleted, isTrue);
    final order = r.api.calls.where((c) => c == 'revokeDevice' || c == 'logout').toList();
    expect(order, ['revokeDevice', 'logout']); // revoke needs the live session, so it comes first
    expect(r.controller.status, AuthStatus.signedOut);
  });

  test('sign-out still completes when the revocation fails (offline, device already gone)', () async {
    final r = Rig();
    await r.signIn();
    r.api.revokeResult = const ApiException(status: 0, code: 'NETWORK');
    await r.controller.signOut();
    expect(r.controller.status, AuthStatus.signedOut);
    expect(await r.store.readDeviceId(), isNull);
  });

  test('a registration failure never breaks the session and can be retried', () async {
    final r = Rig();
    r.api.registerResult = const ApiException(status: 503, code: 'PUSH_NOT_CONFIGURED');
    await r.signIn();
    expect(r.controller.isSignedIn, isTrue);
    expect(await r.store.readDeviceId(), isNull);
  });

  group('forced sign-out and cleanup', () {
    test(
      "a refused refresh (401) ends the session locally and drops this device's FCM token and device id; no revoke without a live token",
      () async {
        final r = Rig();
        await r.signIn();
        r.clock.now = r.clock.now.add(const Duration(minutes: 30)); // access token expired
        r.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_REUSED'));
        await expectLater(r.controller.authorized((_) async {}), throwsA(isA<ApiException>()));
        await r.controller.pendingCleanup;
        expect(r.controller.status, AuthStatus.signedOut);
        expect(r.controller.session, isNull);
        expect(await r.store.load(), isNull);
        expect(await r.store.readDeviceId(), isNull);
        expect(r.gateway.deleted, isTrue);
        expect(r.api.revoked, isEmpty);
      },
    );

    test('a refused refresh (403 account not active) does the same', () async {
      final r = Rig();
      await r.signIn();
      r.clock.now = r.clock.now.add(const Duration(minutes: 30));
      r.api.refreshResults.add(const ApiException(status: 403, code: 'ACCOUNT_NOT_ACTIVE'));
      await expectLater(r.controller.authorized((_) async {}), throwsA(isA<ApiException>()));
      await r.controller.pendingCleanup;
      expect(r.controller.status, AuthStatus.signedOut);
      expect(r.gateway.deleted, isTrue);
      expect(await r.store.readDeviceId(), isNull);
    });

    test('when the access token is still usable the revoke is attempted with it; its failure changes nothing', () async {
      final r = Rig();
      await r.signIn();
      r.api.revokeResult = const ApiException(status: 401, code: 'UNAUTHORIZED');
      r.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_REVOKED'));
      var calls = 0;
      await expectLater(
        r.controller.authorized((_) async {
          if (calls++ == 0) throw const ApiException(status: 401, code: 'UNAUTHORIZED'); // revoked server-side, not yet expired by the clock
        }),
        throwsA(isA<ApiException>()),
      );
      await r.controller.pendingCleanup;
      expect(r.controller.status, AuthStatus.signedOut);
      expect(r.api.revoked, ['device-1']);
      expect(r.api.lastRevokeAccessToken, 'access-1');
      expect(await r.store.readDeviceId(), isNull);
      expect(r.gateway.deleted, isTrue);
    });

    test('restoring an expired stored session clears it and the device registration without any network call', () async {
      final r = Rig();
      await r.store.save(fakeSession(refreshExpiresAt: r.clock.now.subtract(const Duration(days: 1))));
      await r.store.writeDeviceId('device-9');
      await r.controller.restore();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.load(), isNull);
      expect(await r.store.readDeviceId(), isNull);
      expect(r.gateway.deleted, isTrue);
      expect(r.api.calls, isEmpty);
    });

    test('a restore refused by the server (401) also cleans up', () async {
      final r = Rig();
      await r.store.save(fakeSession(refreshExpiresAt: r.clock.now.add(const Duration(days: 5))));
      await r.store.writeDeviceId('device-9');
      r.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_EXPIRED'));
      await r.controller.restore();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.readDeviceId(), isNull);
      expect(r.gateway.deleted, isTrue);
    });

    test('restoring while offline keeps the session and does not touch the registration', () async {
      final r = Rig();
      await r.store.save(fakeSession(refreshExpiresAt: r.clock.now.add(const Duration(days: 5))));
      await r.store.writeDeviceId('device-9');
      r.api.refreshResults.add(const ApiException(status: 0, code: 'NETWORK'));
      await r.controller.restore();
      expect(r.controller.isSignedIn, isTrue);
      expect(await r.store.readDeviceId(), 'device-9');
      expect(r.gateway.deleted, isFalse);
    });

    test('offline sign-out: revoke and logout fail, yet the session and device id are gone and the FCM token dropped', () async {
      final r = Rig();
      await r.signIn();
      r.api.revokeResult = const ApiException(status: 0, code: 'NETWORK');
      r.api.logoutResult = const ApiException(status: 0, code: 'NETWORK');
      await r.controller.signOut();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.load(), isNull);
      expect(await r.store.readDeviceId(), isNull);
      expect(r.gateway.deleted, isTrue);
    });

    test('a hung network never blocks sign-out beyond the cleanup limit', () async {
      final r = Rig(limit: const Duration(milliseconds: 80));
      await r.signIn();
      r.api.revokeDelay = const Duration(seconds: 30);
      r.api.logoutDelay = const Duration(seconds: 30);
      r.gateway.deleteDelay = const Duration(seconds: 30);
      final watch = Stopwatch()..start();
      await r.controller.signOut();
      expect(watch.elapsed, lessThan(const Duration(seconds: 3)));
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.load(), isNull);
      expect(await r.store.readDeviceId(), isNull);
    });

    test('a failing FCM token deletion or a throwing revoke never keeps the session', () async {
      final r = Rig();
      await r.signIn();
      r.gateway.deleteResult = StateError('fcm down');
      r.api.revokeResult = StateError('boom');
      await r.controller.signOut();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.load(), isNull);
    });

    test("cleanup for the previous account cannot touch the next account's registration", () async {
      final r = Rig();
      await r.signIn();
      r.clock.now = r.clock.now.add(const Duration(minutes: 30));
      r.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_REUSED'));
      await expectLater(r.controller.authorized((_) async {}), throwsA(isA<ApiException>()));
      await r.controller.pendingCleanup;
      // another person signs in on the same phone
      r.api.registerResult = 'device-2';
      r.gateway.token = 'fcm-token-2';
      r.gateway.deleted = false;
      await r.signIn();
      expect(await r.store.readDeviceId(), 'device-2');
      expect(r.api.revoked, isNot(contains('device-2')));
      expect(r.gateway.deleted, isFalse);
    });
  });

  test('stopping when nothing was registered is harmless', () async {
    final r = Rig();
    await r.push.stop();
    expect(r.api.calls, isEmpty);
  });

  group('what the app does with a push', () {
    const reply = PushEvent(
      notificationId: 'n-1',
      type: 'support.reply',
      resourceType: 'support_thread',
      resourceId: 't-1',
      title: 'Support replied',
      body: 'Open the app',
    );

    test('a push that arrives while the app is open reaches the app once, even if the backend sends it twice', () async {
      final r = Rig();
      await r.signIn();
      final got = <PushEvent>[];
      final sub = r.push.foreground.listen(got.add);
      addTearDown(sub.cancel);

      r.gateway.foregroundEvents.add(reply);
      r.gateway.foregroundEvents.add(reply);
      await Future<void>.delayed(Duration.zero);

      expect(got, hasLength(1));
      expect(got.single.type, 'support.reply');
      expect(got.single.isSupportReply, isTrue);
      expect(got.single.resourceId, 't-1');
    });

    test('a tap on a push is passed on; the tap that started the app waits until the app listens', () async {
      final r = Rig();
      r.gateway.startedBy = const PushEvent(notificationId: 'n-9', type: 'verification.approved');
      await r.signIn();

      final got = <PushEvent>[];
      final sub = r.push.opened.listen(got.add); // listens AFTER start, like an app that is still building its first screen
      addTearDown(sub.cancel);
      await Future<void>.delayed(Duration.zero);
      expect(got.map((e) => e.type), ['verification.approved']);
      expect(got.single.isVerification, isTrue);

      r.gateway.openedEvents.add(reply);
      await Future<void>.delayed(Duration.zero);
      expect(got.map((e) => e.type), ['verification.approved', 'support.reply']);
    });

    test('nothing is passed on once the person has signed out', () async {
      final r = Rig();
      await r.signIn();
      final got = <PushEvent>[];
      final sub = r.push.foreground.listen(got.add);
      addTearDown(sub.cancel);
      await r.controller.signOut();
      r.gateway.foregroundEvents.add(reply);
      await Future<void>.delayed(Duration.zero);
      expect(got, isEmpty);
    });

    test('event data is read from the backend map, and missing parts stay null', () {
      final e = PushEvent.fromData({'notificationId': 'x', 'type': 'verification.rejected'}, title: 'T', body: 'B');
      expect(e.isVerification, isTrue);
      expect(e.resourceType, isNull);
      expect(e.title, 'T');
      expect(PushEvent.fromData(const {}).type, isNull);
    });
  });
}
