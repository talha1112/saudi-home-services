import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h) =>
    HsApi(baseUrl: 'https://api.example.com/api/v1', client: MockClient(h), clock: () => DateTime.utc(2026, 11, 1));
http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  group('the customer reads the professional position', () {
    test('GET /bookings/:id/location with the token; a shared position is parsed', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {
          'available': true,
          'location': {'latitude': 24.7136, 'longitude': 46.6753},
          'ageSeconds': 7,
        });
      });
      final p = await api.workerPosition('tok', 'b 1');
      expect(seen.method, 'GET');
      expect(seen.url.path, endsWith('/bookings/b%201/location'));
      expect(seen.headers['authorization'], 'Bearer tok');
      expect(p.available, isTrue);
      expect(p.latitude, 24.7136);
      expect(p.longitude, 46.6753);
      expect(p.ageSeconds, 7);
    });

    test('"sharing not active" and "no recent position" are told apart', () async {
      final api = _api((r) async => _json(200, {'available': false, 'reason': 'SHARING_NOT_ACTIVE'}));
      expect((await api.workerPosition('t', 'b')).reason, LiveLocationReason.notActive);
      final api2 = _api((r) async => _json(200, {'available': false, 'reason': 'NO_RECENT_POSITION'}));
      expect((await api2.workerPosition('t', 'b')).reason, LiveLocationReason.noRecentPosition);
    });

    test('a position that cannot be real is never drawn: missing, out of range, or 0,0 become "no recent position"', () {
      for (final loc in <Object?>[
        null,
        {'latitude': 0, 'longitude': 0},
        {'latitude': 91, 'longitude': 10},
        {'latitude': 10, 'longitude': -181},
        {'latitude': 'x', 'longitude': 10},
        {'latitude': 24.0},
      ]) {
        final p = LiveLocation.fromJson({'available': true, 'location': loc, 'ageSeconds': 1});
        expect(p.available, isFalse, reason: '$loc');
        expect(p.reason, LiveLocationReason.noRecentPosition);
      }
    });

    test('errors surface as ApiException', () async {
      final api = _api((r) async => _json(403, {'code': 'FORBIDDEN', 'message': 'no'}));
      expect(() => api.workerPosition('t', 'b'), throwsA(isA<ApiException>()));
    });
  });

  group('the worker reports a position', () {
    test('POST /workers/me/bookings/:id/location with the fields, in UTC, leaving out what is unknown', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {'accepted': true});
      });
      await api.reportPosition('tok', 'b-1', latitude: 24.7, longitude: 46.6, recordedAt: DateTime.utc(2026, 11, 1, 10, 30), accuracyMeters: 12.5);
      expect(seen.method, 'POST');
      expect(seen.url.path, endsWith('/workers/me/bookings/b-1/location'));
      expect(seen.headers['authorization'], 'Bearer tok');
      final body = jsonDecode(seen.body) as Map<String, dynamic>;
      expect(body['latitude'], 24.7);
      expect(body['longitude'], 46.6);
      expect(body['recordedAt'], '2026-11-01T10:30:00.000Z');
      expect(body['accuracyMeters'], 12.5);
      expect(body.containsKey('headingDegrees'), isFalse);
      expect(body.containsKey('speedMps'), isFalse);
    });

    test('a rejected report is an ApiException the caller can act on', () async {
      final api = _api((r) async => _json(429, {'code': 'RATE_LIMITED', 'message': 'slow down'}));
      await expectLater(
        api.reportPosition('t', 'b', latitude: 1, longitude: 2, recordedAt: DateTime.utc(2026)),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 429)),
      );
    });
  });

  group('push events about bookings', () {
    PushEvent e(String type, {String? resourceType = 'booking', String? id = 'b-1'}) =>
        PushEvent(notificationId: 'n', type: type, resourceType: resourceType, resourceId: id);

    test('booking steps and chat are booking pushes; chat is told apart', () {
      for (final t in [
        'request.new',
        'quote.received',
        'quote.accepted',
        'payment.confirmed',
        'work.started',
        'work.completed',
        'booking.cancelled',
      ]) {
        expect(e(t).isBooking, isTrue, reason: t);
        expect(e(t).isChat, isFalse, reason: t);
      }
      expect(e('chat.message').isBooking, isTrue);
      expect(e('chat.message').isChat, isTrue);
    });

    test('a push without a booking, or about something else, is not a booking push', () {
      expect(e('quote.received', id: null).isBooking, isFalse);
      expect(e('support.reply', resourceType: 'support').isBooking, isFalse);
      expect(e('support.reply', resourceType: null, id: null).isBooking, isFalse);
    });
  });
}
