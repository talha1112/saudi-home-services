import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';

import 'package:hs_client/testing.dart';

class Rig {
  Rig({AppKind kind = AppKind.customer}) {
    controller = AuthController(api: api, store: store, phone: phone, kind: kind, clock: clock.call);
  }

  final api = FakeApi();
  final phone = FakePhone();
  final kv = MemoryKeyValueStore();
  late final store = SessionStore(kv);
  final clock = Clock();
  late final AuthController controller;
  int signedInCalls = 0;
  int beforeSignOutCalls = 0;
  final events = <String>[];

  void hooks() {
    controller.onSignedIn = () async {
      signedInCalls++;
      events.add('signedIn');
    };
    controller.onBeforeSignOut = () async {
      beforeSignOutCalls++;
      events.add('beforeSignOut');
    };
  }
}

const phoneNumber = '+966501234567';

void main() {
  group('signing in', () {
    test('sends the code, confirms it, exchanges the Firebase token for a session and stores only the refresh token', () async {
      final r = Rig(kind: AppKind.worker)..hooks();
      r.api.signInResult = fakeSession(
        isNew: true,
        user: fakeUser(role: 'WORKER', workerStatus: 'NOT_SUBMITTED'),
      );

      expect(await r.controller.sendCode(phoneNumber, languageCode: 'ar'), isTrue);
      expect(r.controller.status, AuthStatus.codeSent);
      expect(r.phone.lastPhone, phoneNumber);
      expect(r.phone.lastLanguage, 'ar');
      expect(r.controller.pendingPhone, phoneNumber);

      expect(await r.controller.submitCode('123456'), isTrue);
      expect(r.controller.status, AuthStatus.signedIn);
      expect(r.controller.isSignedIn, isTrue);
      expect(r.controller.user!.workerVerificationStatus, 'NOT_SUBMITTED');
      expect(r.api.lastIdToken, 'firebase-id-token-1');
      expect(r.api.lastApp, AppKind.worker);
      expect(r.signedInCalls, 1);
      expect(r.phone.calls, containsAllInOrder(['sendCode', 'confirmCode']));
      await Future<void>.delayed(Duration.zero);
      expect(r.phone.calls, contains('firebaseSignOut')); // the Firebase session is not kept

      final stored = r.kv.values.values.join();
      expect(stored, contains('refresh-1'));
      expect(stored, isNot(contains('access-1'))); // access tokens are never persisted
      expect(r.controller.pendingPhone, isNull);
    });

    test('rejects a malformed number before asking Firebase, and a malformed code before asking Firebase', () async {
      final r = Rig();
      expect(await r.controller.sendCode('0501234567'), isFalse); // not E.164
      expect(r.controller.issue, AuthIssue.invalidPhone);
      expect(r.phone.calls, isEmpty);

      await r.controller.sendCode(phoneNumber);
      for (final bad in ['12345', '1234567', 'abcdef', '12 456']) {
        expect(await r.controller.submitCode(bad), isFalse);
        expect(r.controller.issue, AuthIssue.invalidCode);
        expect(r.controller.status, AuthStatus.codeSent);
      }
      expect(r.phone.calls.where((c) => c == 'confirmCode'), isEmpty);
    });

    test('a wrong code can be retried; an expired one says so', () async {
      final r = Rig();
      r.api.signInResult = fakeSession();
      await r.controller.sendCode(phoneNumber);
      r.phone.confirmResult = const PhoneAuthFailure(AuthIssue.invalidCode);
      expect(await r.controller.submitCode('111111'), isFalse);
      expect(r.controller.issue, AuthIssue.invalidCode);
      expect(r.controller.status, AuthStatus.codeSent);

      r.phone.confirmResult = const PhoneAuthFailure(AuthIssue.codeExpired);
      expect(await r.controller.submitCode('111111'), isFalse);
      expect(r.controller.issue, AuthIssue.codeExpired);

      r.phone.confirmResult = 'firebase-id-token-2';
      expect(await r.controller.submitCode('222222'), isTrue);
      expect(r.api.lastIdToken, 'firebase-id-token-2');
      expect(r.controller.issue, isNull);
    });

    test('Firebase refusing to send the code is reported and leaves the person on the phone screen', () async {
      final r = Rig();
      for (final issue in [AuthIssue.tooManyRequests, AuthIssue.network, AuthIssue.appNotAuthorized, AuthIssue.invalidPhone]) {
        r.phone.sendResult = PhoneAuthFailure(issue);
        expect(await r.controller.sendCode(phoneNumber), isFalse);
        expect(r.controller.issue, issue);
        expect(r.controller.status, AuthStatus.signedOut);
      }
      r.phone.sendResult = StateError('unexpected');
      expect(await r.controller.sendCode(phoneNumber), isFalse);
      expect(r.controller.issue, AuthIssue.generic);
    });

    test('backend refusals keep the person signed out, with the reason', () async {
      for (final entry in {
        const ApiException(status: 403, code: 'ACCOUNT_SUSPENDED'): AuthIssue.accountSuspended,
        const ApiException(status: 403, code: 'ACCOUNT_DEACTIVATED'): AuthIssue.accountDeactivated,
        const ApiException(status: 403, code: 'ACCOUNT_NOT_ELIGIBLE'): AuthIssue.notEligible,
        const ApiException(status: 409, code: 'ACCOUNT_LINK_REVIEW_REQUIRED'): AuthIssue.accountNeedsReview,
        const ApiException(status: 409, code: 'FIREBASE_IDENTITY_CONFLICT'): AuthIssue.accountNeedsReview,
        const ApiException(status: 401, code: 'FIREBASE_TOKEN_REPLAYED'): AuthIssue.verificationFailed,
        const ApiException(status: 429, code: 'RATE_LIMITED'): AuthIssue.tooManyRequests,
      }.entries) {
        final r = Rig()..hooks();
        r.api.signInResult = entry.key;
        await r.controller.sendCode(phoneNumber);
        expect(await r.controller.submitCode('123456'), isFalse);
        expect(r.controller.issue, entry.value);
        expect(r.controller.status, AuthStatus.signedOut);
        expect(r.controller.isSignedIn, isFalse);
        expect(r.signedInCalls, 0);
        expect(r.kv.values, isEmpty); // nothing is stored for a refused sign-in
      }
    });

    test('a network or server hiccup after the code was accepted lets the person try again without a new SMS', () async {
      final r = Rig();
      await r.controller.sendCode(phoneNumber);
      r.api.signInResult = const ApiException(status: 0, code: 'NETWORK');
      expect(await r.controller.submitCode('123456'), isFalse);
      expect(r.controller.issue, AuthIssue.network);
      expect(r.controller.status, AuthStatus.codeSent);

      r.api.signInResult = const ApiException(status: 503, code: 'FIREBASE_UNAVAILABLE');
      expect(await r.controller.submitCode('123456'), isFalse);
      expect(r.controller.issue, AuthIssue.unavailable);
      expect(r.controller.status, AuthStatus.codeSent);

      r.api.signInResult = fakeSession();
      expect(await r.controller.submitCode('123456'), isTrue);
    });

    test('a push-setup failure never fails the sign-in', () async {
      final r = Rig();
      r.api.signInResult = fakeSession();
      r.controller.onSignedIn = () async => throw StateError('push is broken');
      await r.controller.sendCode(phoneNumber);
      expect(await r.controller.submitCode('123456'), isTrue);
      expect(r.controller.isSignedIn, isTrue);
    });
  });

  group('instant and automatic verification', () {
    test('a number Firebase verifies without a typed code signs in straight away', () async {
      final r = Rig();
      r.api.signInResult = fakeSession();
      r.phone.sendResult = const AutoVerified('instant-token');
      expect(await r.controller.sendCode(phoneNumber), isTrue);
      expect(r.controller.status, AuthStatus.signedIn);
      expect(r.api.lastIdToken, 'instant-token');
    });

    test('an SMS read automatically after the code screen is showing completes the sign-in', () async {
      final r = Rig();
      r.api.signInResult = fakeSession();
      await r.controller.sendCode(phoneNumber);
      r.phone.auto.add('auto-token');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(r.controller.status, AuthStatus.signedIn);
      expect(r.api.lastIdToken, 'auto-token');
    });

    test('an automatic token is ignored when nobody is waiting for a code', () async {
      final r = Rig();
      r.phone.auto.add('stray-token');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(r.api.calls, isEmpty);
    });
  });

  group('resending', () {
    test('only after the cooldown, with the resend token, and "change number" starts over', () async {
      final r = Rig();
      await r.controller.sendCode(phoneNumber);
      expect(r.controller.canResend, isFalse);
      expect(await r.controller.resendCode(), isFalse);
      expect(r.phone.calls.where((c) => c == 'sendCode'), hasLength(1));

      r.clock.now = r.clock.now.add(const Duration(seconds: 61));
      expect(r.controller.canResend, isTrue);
      expect(await r.controller.resendCode(languageCode: 'en'), isTrue);
      expect(r.phone.lastResendToken, 7);
      expect(r.phone.calls.where((c) => c == 'sendCode'), hasLength(2));
      expect(r.controller.canResend, isFalse); // the cooldown starts again

      r.controller.backToPhone();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.controller.submitCode('123456'), isFalse); // there is no pending code any more
    });

    test('a failed resend keeps the earlier code usable', () async {
      final r = Rig();
      await r.controller.sendCode(phoneNumber);
      r.clock.now = r.clock.now.add(const Duration(seconds: 61));
      r.phone.sendResult = const PhoneAuthFailure(AuthIssue.tooManyRequests);
      expect(await r.controller.resendCode(), isFalse);
      expect(r.controller.status, AuthStatus.codeSent);
      expect(r.controller.issue, AuthIssue.tooManyRequests);
    });
  });

  group('restoring a session', () {
    test('nothing stored means signed out', () async {
      final r = Rig();
      await r.controller.restore();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(r.api.calls, isEmpty);
    });

    test('a stored session is renewed, the NEW refresh token replaces the old one, and push setup runs', () async {
      final r = Rig()..hooks();
      await r.store.save(fakeSession(refresh: 'refresh-old'));
      r.api.refreshResults.add(
        fakeSession(access: 'access-2', refresh: 'refresh-new', accessExpiresAt: r.clock.now.add(const Duration(minutes: 15))),
      ); // times follow the test clock
      await r.controller.restore();
      expect(r.controller.status, AuthStatus.signedIn);
      expect(r.api.lastRefreshTokenUsed, 'refresh-old');
      expect((await r.store.load())!.refreshToken, 'refresh-new');
      expect(await r.controller.accessToken(), 'access-2');
      expect(r.signedInCalls, 1);
    });

    test('a session the server rejects, or whose refresh token expired, is discarded', () async {
      final rejected = Rig();
      await rejected.store.save(fakeSession());
      rejected.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_INVALID'));
      await rejected.controller.restore();
      expect(rejected.controller.status, AuthStatus.signedOut);
      expect(await rejected.store.load(), isNull);

      final expired = Rig();
      await expired.store.save(fakeSession(refreshExpiresAt: expired.clock.now.subtract(const Duration(days: 1))));
      await expired.controller.restore();
      expect(expired.controller.status, AuthStatus.signedOut);
      expect(expired.api.calls, isEmpty);
      expect(await expired.store.load(), isNull);
    });

    test('being offline at start keeps the session (signed in, renewed on the next call)', () async {
      final r = Rig();
      await r.store.save(fakeSession());
      r.api.refreshResults.add(const ApiException(status: 0, code: 'NETWORK'));
      await r.controller.restore();
      expect(r.controller.status, AuthStatus.signedIn);
      expect(r.controller.issue, AuthIssue.network);
      expect(await r.store.load(), isNotNull);
    });

    test('a corrupt stored record is just "signed out"', () async {
      final r = Rig();
      r.kv.values['hs.session.v1'] = '{not json';
      await r.controller.restore();
      expect(r.controller.status, AuthStatus.signedOut);
    });
  });

  group('access tokens and renewal', () {
    Future<Rig> signedIn({Duration accessLife = const Duration(minutes: 15)}) async {
      final r = Rig()..hooks();
      r.api.signInResult = fakeSession(accessExpiresAt: r.clock.now.add(accessLife));
      await r.controller.sendCode(phoneNumber);
      await r.controller.submitCode('123456');
      return r;
    }

    test('returns the current token while it is valid, and renews when it is about to expire', () async {
      final r = await signedIn();
      expect(await r.controller.accessToken(), 'access-1');
      expect(r.api.calls.where((c) => c == 'refresh'), isEmpty);

      r.clock.now = r.clock.now.add(const Duration(minutes: 14, seconds: 30)); // inside the 60 s margin
      r.api.refreshResults.add(fakeSession(access: 'access-2', refresh: 'refresh-2', accessExpiresAt: r.clock.now.add(const Duration(minutes: 15))));
      expect(await r.controller.accessToken(), 'access-2');
      expect((await r.store.load())!.refreshToken, 'refresh-2');
    });

    test('many callers at once share ONE renewal (the refresh token is single use)', () async {
      final r = await signedIn(accessLife: const Duration(seconds: 10));
      r.api.refreshDelay = const Duration(milliseconds: 40);
      r.api.refreshResults.add(fakeSession(access: 'access-2', refresh: 'refresh-2', accessExpiresAt: r.clock.now.add(const Duration(minutes: 15))));
      final tokens = await Future.wait([for (var i = 0; i < 8; i++) r.controller.accessToken()]);
      expect(tokens.toSet(), {'access-2'});
      expect(r.api.calls.where((c) => c == 'refresh'), hasLength(1));
      expect(r.api.lastRefreshTokenUsed, 'refresh-1');
    });

    test('a 401 on a call renews once and retries it', () async {
      final r = await signedIn();
      r.api.refreshResults.add(fakeSession(access: 'access-2', refresh: 'refresh-2'));
      var attempts = 0;
      final seen = <String>[];
      final result = await r.controller.authorized((token) async {
        seen.add(token);
        if (attempts++ == 0) throw const ApiException(status: 401, code: 'TOKEN_EXPIRED');
        return 'ok';
      });
      expect(result, 'ok');
      expect(seen, ['access-1', 'access-2']);
    });

    test('when renewal fails with 401 the person is signed out locally', () async {
      final r = await signedIn();
      r.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_INVALID'));
      await expectLater(
        r.controller.authorized((t) async => throw const ApiException(status: 401, code: 'TOKEN_EXPIRED')),
        throwsA(isA<ApiException>()),
      );
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.load(), isNull);
    });

    test('other errors are passed on without touching the session', () async {
      final r = await signedIn();
      await expectLater(r.controller.authorized((t) async => throw const ApiException(status: 403, code: 'FORBIDDEN')), throwsA(isA<ApiException>()));
      expect(r.controller.isSignedIn, isTrue);
      expect(r.api.calls.where((c) => c == 'refresh'), isEmpty);
    });

    test('without a session there is no token', () async {
      final r = Rig();
      expect(await r.controller.accessToken(), isNull);
      await expectLater(r.controller.authorized((t) async => 'x'), throwsA(isA<ApiException>()));
    });
  });

  group('signing out', () {
    test('push is revoked first (while the session still works), then the server session ends, then local data is cleared', () async {
      final r = Rig()..hooks();
      r.api.signInResult = fakeSession();
      await r.controller.sendCode(phoneNumber);
      await r.controller.submitCode('123456');
      r.events.clear();
      await r.store.writeDeviceId('device-1');
      await r.controller.signOut();

      expect(r.events, ['beforeSignOut']);
      expect(r.api.lastLogoutToken, 'refresh-1');
      expect(r.controller.status, AuthStatus.signedOut);
      expect(r.controller.session, isNull);
      expect(await r.store.load(), isNull);
      expect(await r.store.readDeviceId(), isNull);
      expect(await r.controller.accessToken(), isNull);
    });

    test('still ends locally when the server or the push cleanup fails', () async {
      final r = Rig();
      r.api.signInResult = fakeSession();
      r.controller.onBeforeSignOut = () async => throw StateError('push failed');
      r.api.logoutResult = const ApiException(status: 0, code: 'NETWORK');
      await r.controller.sendCode(phoneNumber);
      await r.controller.submitCode('123456');
      await r.controller.signOut();
      expect(r.controller.status, AuthStatus.signedOut);
      expect(await r.store.load(), isNull);
    });
  });
}
