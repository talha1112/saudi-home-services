import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h) =>
    HsApi(baseUrl: 'https://api.example.com/api/v1', client: MockClient(h), clock: () => DateTime.utc(2026, 11, 1));
http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Future<TestHsClient> _signedIn() async {
  final kit = TestHsClient();
  kit.api.signInResult = fakeSession(accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)));
  await kit.client.auth.sendCode('+966501234567');
  await kit.client.auth.submitCode('123456');
  return kit;
}

void main() {
  group('notifications', () {
    test('the list: path, token, and each entry parsed (the booking it is about, whether it is read)', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {
          'items': [
            {
              'id': 'n-1',
              'type': 'quote.received',
              'title': 'New quote received',
              'body': 'You received a quote for booking BK-1.',
              'resource': {'type': 'booking', 'id': 'b-1'},
              'read': false,
              'createdAt': '2026-11-01T10:00:00.000Z',
            },
            {
              'id': 'n-2',
              'type': 'admin.announcement',
              'title': 'Hello',
              'body': 'All',
              'resource': null,
              'read': true,
              'createdAt': '2026-10-30T10:00:00.000Z',
            },
          ],
          'meta': {'page': 1, 'limit': 30, 'total': 2, 'totalPages': 1},
        });
      });
      final page = await api.notifications('tok');
      expect(seen.method, 'GET');
      expect(seen.url.path, '/api/v1/notifications');
      expect(seen.url.queryParameters, {'page': '1', 'limit': '30'});
      expect(seen.headers['authorization'], 'Bearer tok');
      expect(page.total, 2);
      expect(page.items[0].isBooking, isTrue);
      expect(page.items[0].resourceId, 'b-1');
      expect(page.items[0].read, isFalse);
      expect(page.items[1].isBooking, isFalse);
      expect(page.items[1].read, isTrue);
      expect(page.items[0].asRead().read, isTrue);
    });

    test('unread count, mark one read, mark all read', () async {
      final seen = <String>[];
      final api = _api((r) async {
        seen.add('${r.method} ${r.url.path}');
        return _json(200, r.url.path.endsWith('unread-count') ? {'unread': 4} : {'updated': 4});
      });
      expect(await api.unreadNotifications('t'), 4);
      await api.markNotificationRead('t', 'n 1');
      await api.markAllNotificationsRead('t');
      expect(seen, ['GET /api/v1/notifications/unread-count', 'POST /api/v1/notifications/n%201/read', 'POST /api/v1/notifications/read-all']);
    });
  });

  group('offers and reviews', () {
    test('offers parse the title, text, ribbon and dates', () async {
      final api = _api(
        (r) async => _json(200, {
          'items': [
            {
              'id': 'o-1',
              'title': '20% off AC',
              'description': 'Any unit',
              'terms': '20% OFF',
              'locale': 'en',
              'startsAt': '2026-11-01T00:00:00.000Z',
              'endsAt': '2026-11-15T00:00:00.000Z',
              'cityId': null,
              'serviceId': 's-1',
            },
          ],
          'meta': {'page': 1, 'limit': 50, 'total': 1, 'totalPages': 1},
        }),
      );
      final o = (await api.offers('t')).single;
      expect(o.title, '20% off AC');
      expect(o.terms, '20% OFF');
      expect(o.endsAt, DateTime.utc(2026, 11, 15));
      expect(o.cityId, isNull);
      expect(o.serviceId, 's-1');
    });

    test('the worker reviews: average, count and the latest comments', () async {
      final api = _api(
        (r) async => _json(200, {
          'summary': {
            'count': 2,
            'average': 4.5,
            'distribution': {'4': 1, '5': 1},
          },
          'items': [
            {'id': 'r-1', 'rating': 5, 'comment': 'On time', 'createdAt': '2026-11-01T10:00:00.000Z'},
            {'id': 'r-2', 'rating': 4, 'comment': null, 'createdAt': '2026-10-01T10:00:00.000Z'},
          ],
          'meta': {'page': 1, 'limit': 10, 'total': 2, 'totalPages': 1},
        }),
      );
      final r = await api.receivedReviews('t');
      expect(r.count, 2);
      expect(r.average, 4.5);
      expect(r.items.map((i) => i.rating), [5, 4]);
      expect(r.items[1].comment, isNull);
    });

    test('no reviews yet means no average, not zero', () async {
      final api = _api(
        (r) async => _json(200, {
          'summary': {'count': 0, 'average': null, 'distribution': {}},
          'items': [],
          'meta': {'page': 1, 'limit': 10, 'total': 0, 'totalPages': 1},
        }),
      );
      final r = await api.receivedReviews('t');
      expect(r.average, isNull);
      expect(r.items, isEmpty);
    });
  });

  group('my review of a booking', () {
    test('GET gives the review, and 404 means none written yet', () async {
      var n = 0;
      final api = _api(
        (r) async => n++ == 0
            ? _json(200, {'id': 'r-1', 'bookingId': 'b-1', 'rating': 4, 'comment': 'Good', 'status': 'PUBLISHED'})
            : _json(404, {'statusCode': 404, 'code': 'NOT_FOUND'}),
      );
      final mine = await api.myReview('t', 'b-1');
      expect(mine!.rating, 4);
      expect(mine.status, 'PUBLISHED');
      expect(await api.myReview('t', 'b-2'), isNull);
    });

    test('other failures are not hidden as "no review"', () async {
      final api = _api((r) async => _json(503, {'statusCode': 503, 'code': 'UNAVAILABLE'}));
      await expectLater(api.myReview('t', 'b-1'), throwsA(isA<ApiException>()));
    });

    test('submitting posts the stars and a trimmed comment, and leaves the comment out when blank', () async {
      final bodies = <Map<String, dynamic>>[];
      final api = _api((r) async {
        bodies.add(jsonDecode(r.body) as Map<String, dynamic>);
        expect(r.method, 'POST');
        expect(r.url.path, '/api/v1/bookings/b-1/review');
        return _json(201, {'id': 'r-1', 'rating': 5, 'comment': null, 'status': 'PUBLISHED'});
      });
      await api.submitReview('t', 'b-1', rating: 5, comment: '  On time  ');
      await api.submitReview('t', 'b-1', rating: 3, comment: '   ');
      expect(bodies, [
        {'rating': 5, 'comment': 'On time'},
        {'rating': 3},
      ]);
    });
  });

  group('my name', () {
    test('PATCH /customers/me with the name; the saved name comes back', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {'userId': 'u-1', 'fullName': 'Sara Al-Qahtani', 'marketingOptIn': false, 'createdAt': '2026-11-01T10:00:00.000Z'});
      });
      expect(await api.updateCustomerName('tok', 'Sara  Al-Qahtani'), 'Sara Al-Qahtani');
      expect(seen.method, 'PATCH');
      expect(seen.url.path, '/api/v1/customers/me');
      expect(jsonDecode(seen.body), {'fullName': 'Sara  Al-Qahtani'});
    });

    test('the signed-in session shows the new name at once and keeps it after a restart', () async {
      final kit = await _signedIn();
      var heard = 0;
      kit.client.auth.addListener(() => heard++);
      await kit.client.auth.updateName('Sara Al-Qahtani');
      expect(kit.client.auth.user!.fullName, 'Sara Al-Qahtani');
      expect(kit.client.auth.user!.phone, isNotNull);
      expect(heard, greaterThan(0));
      final stored = await SessionStore(kit.kv).load();
      expect(stored!.user.fullName, 'Sara Al-Qahtani');
    });

    test('a refused name leaves the name as it was', () async {
      final kit = await _signedIn();
      final before = kit.client.auth.user!.fullName;
      kit.api.updateNameResult = const ApiException(status: 400, code: 'VALIDATION');
      await expectLater(kit.client.auth.updateName('x'), throwsA(isA<ApiException>()));
      expect(kit.client.auth.user!.fullName, before);
    });
  });
}
