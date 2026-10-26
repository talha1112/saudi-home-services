import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _sessionJson = {
  'tokenType': 'Bearer',
  'accessToken': 'access-abc',
  'accessTokenExpiresInSeconds': 900,
  'refreshToken': 'refresh-abc',
  'refreshTokenExpiresAt': '2026-12-01T00:00:00.000Z',
  'isNewUser': true,
  'user': {
    'id': 'u-1',
    'phone': '+966501234567',
    'email': null,
    'fullName': null,
    'locale': 'AR',
    'status': 'ACTIVE',
    'roles': ['WORKER'],
    'activeRole': 'WORKER',
    'workerVerificationStatus': 'NOT_SUBMITTED',
    'mustChangePassword': false,
  },
};

HsApi api(Future<http.Response> Function(http.Request) handler, {Duration timeout = const Duration(seconds: 5)}) => HsApi(
  baseUrl: 'https://api.example.com/api/v1/',
  client: MockClient((r) => handler(r)),
  timeout: timeout,
  clock: () => DateTime.utc(2026, 11, 1, 10),
);

http.Response json(int status, Object body, {Map<String, String> headers = const {}}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json', ...headers});

void main() {
  test('sign-in sends only the ID token and the app kind, and parses the session', () async {
    late http.Request seen;
    final client = api((r) async {
      seen = r;
      return json(200, _sessionJson);
    });
    final session = await client.signInWithFirebase(idToken: 'id-token-123', app: AppKind.worker);

    expect(seen.method, 'POST');
    expect(seen.url.toString(), 'https://api.example.com/api/v1/auth/firebase/phone'); // trailing slash handled
    expect(jsonDecode(seen.body), {'idToken': 'id-token-123', 'app': 'worker'}); // no phone number, user id or role
    expect(seen.headers['authorization'], isNull);
    expect(seen.headers['content-type'], contains('application/json'));
    expect(session.accessToken, 'access-abc');
    expect(session.accessExpiresAt, DateTime.utc(2026, 11, 1, 10, 15));
    expect(session.refreshExpiresAt, DateTime.utc(2026, 12, 1));
    expect(session.isNewUser, isTrue);
    expect(session.user.roles, ['WORKER']);
    expect(session.user.workerVerificationStatus, 'NOT_SUBMITTED');
    expect(session.user.isApprovedWorker, isFalse);
  });

  test('refresh, logout, me and devices use the right routes, bodies and bearer token', () async {
    final seen = <http.Request>[];
    final client = api((r) async {
      seen.add(r);
      if (r.url.path.endsWith('/auth/logout') || r.method == 'DELETE') return http.Response('', 204);
      if (r.url.path.endsWith('/devices')) return json(200, {'id': 'device-9', 'platform': 'ANDROID', 'provider': 'FCM'});
      if (r.url.path.endsWith('/auth/me')) return json(200, _sessionJson['user']!);
      return json(200, _sessionJson);
    });
    await client.refresh('old-refresh');
    await client.logout('old-refresh');
    final me = await client.me('access-1');
    final id = await client.registerDevice(accessToken: 'access-1', platform: 'ANDROID', token: 'fcm-xyz');
    await client.revokeDevice(accessToken: 'access-1', deviceId: 'device-9');

    expect(seen.map((r) => '${r.method} ${r.url.path}'), [
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/logout',
      'GET /api/v1/auth/me',
      'POST /api/v1/devices',
      'DELETE /api/v1/devices/device-9',
    ]);
    expect(jsonDecode(seen[0].body), {'refreshToken': 'old-refresh'});
    expect(seen[0].headers['authorization'], isNull);
    for (final r in seen.skip(2)) {
      expect(r.headers['authorization'], 'Bearer access-1');
    }
    expect(jsonDecode(seen[3].body), {'platform': 'ANDROID', 'provider': 'FCM', 'token': 'fcm-xyz'}); // no user id
    expect(me.id, 'u-1');
    expect(id, 'device-9');
  });

  test('turns an error response into an ApiException with the stable code and Retry-After', () async {
    final client = api((r) async => json(429, {'statusCode': 429, 'code': 'OTP_RATE', 'message': 'slow down', 'retryAfterSeconds': 42}));
    final e =
        await client.signInWithFirebase(idToken: 't', app: AppKind.customer).then<Object?>((_) => null, onError: (Object e) => e) as ApiException;
    expect(e.status, 429);
    expect(e.code, 'OTP_RATE');
    expect(e.retryAfterSeconds, 42);
    expect(e.issue, AuthIssue.tooManyRequests);

    final header = api((r) async => http.Response('nope', 503, headers: {'retry-after': '9'}));
    final e2 = await header.me('x').then<Object?>((_) => null, onError: (Object e) => e) as ApiException;
    expect(e2.code, 'HTTP_503');
    expect(e2.retryAfterSeconds, 9);
    expect(e2.issue, AuthIssue.unavailable);
  });

  test('maps every backend sign-in code to an issue', () {
    AuthIssue issue(String code, [int status = 401]) => ApiException(status: status, code: code).issue;
    expect(issue('FIREBASE_TOKEN_EXPIRED'), AuthIssue.codeExpired);
    expect(issue('FIREBASE_TOKEN_STALE'), AuthIssue.codeExpired);
    for (final c in [
      'FIREBASE_TOKEN_INVALID',
      'FIREBASE_TOKEN_REPLAYED',
      'FIREBASE_PHONE_MISSING',
      'FIREBASE_PHONE_INVALID',
      'FIREBASE_PROVIDER_NOT_ALLOWED',
    ]) {
      expect(issue(c), AuthIssue.verificationFailed);
    }
    expect(issue('ACCOUNT_SUSPENDED', 403), AuthIssue.accountSuspended);
    expect(issue('ACCOUNT_DEACTIVATED', 403), AuthIssue.accountDeactivated);
    expect(issue('ACCOUNT_NOT_ELIGIBLE', 403), AuthIssue.notEligible);
    expect(issue('ACCOUNT_LINK_REVIEW_REQUIRED', 409), AuthIssue.accountNeedsReview);
    expect(issue('FIREBASE_IDENTITY_CONFLICT', 409), AuthIssue.accountNeedsReview);
    expect(issue('FIREBASE_AUTH_NOT_CONFIGURED', 503), AuthIssue.unavailable);
    expect(issue('FIREBASE_UNAVAILABLE', 503), AuthIssue.unavailable);
    expect(issue('SOMETHING', 500), AuthIssue.generic);
    expect(const ApiException(status: 0, code: 'NETWORK').issue, AuthIssue.network);
  });

  test('network trouble (no connection, TLS failure, timeout) is reported as a network error', () async {
    for (final failure in <Object>[const SocketException('down'), http.ClientException('down'), const HandshakeException('tls')]) {
      final e = await api((r) async => throw failure).me('x').then<Object?>((_) => null, onError: (Object e) => e) as ApiException;
      expect(e.isNetwork, isTrue);
      expect(e.issue, AuthIssue.network);
    }
    final slow = api((r) => Completer<http.Response>().future, timeout: const Duration(milliseconds: 50));
    final e = await slow.me('x').then<Object?>((_) => null, onError: (Object e) => e) as ApiException;
    expect(e.isNetwork, isTrue);
  });

  test('revoking a device that is already gone counts as done; other failures are reported', () async {
    await api((r) async => json(404, {'code': 'NOT_FOUND'})).revokeDevice(accessToken: 'a', deviceId: 'd');
    final e =
        await api(
              (r) async => json(401, {'code': 'TOKEN_EXPIRED'}),
            ).revokeDevice(accessToken: 'a', deviceId: 'd').then<Object?>((_) => null, onError: (Object e) => e)
            as ApiException;
    expect(e.isUnauthorized, isTrue);
  });

  test('exceptions never contain tokens', () async {
    final e =
        await api(
              (r) async => json(401, {'code': 'FIREBASE_TOKEN_INVALID', 'message': 'could not be verified'}),
            ).signInWithFirebase(idToken: 'SECRET-ID-TOKEN', app: AppKind.customer).then<Object?>((_) => null, onError: (Object e) => e)
            as ApiException;
    expect(e.toString(), isNot(contains('SECRET')));
  });
}
