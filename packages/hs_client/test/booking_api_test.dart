import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h) =>
    HsApi(baseUrl: 'https://api.example.com/api/v1', client: MockClient(h), clock: () => DateTime.utc(2026, 11, 1));
http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

const _fields = <String, Object>{
  'addressLine': 'King Fahd Rd, Al Olaya, Riyadh 12211',
  'district': 'Al Olaya',
  'building': '12, Unit 4, Floor 2',
  'locationNotes': 'Ring the bell twice',
  'latitude': 24.7136,
  'longitude': 46.6753,
};

CreateBookingRequest _request([Map<String, Object> fields = _fields]) => CreateBookingRequest(
  serviceId: '0190-service',
  cityId: '0190-city',
  problemDescription: 'The kitchen outlet sparks whenever I plug something in.',
  preferredStartAt: DateTime.parse('2026-11-03T09:00:00+03:00'),
  preferredEndAt: DateTime.parse('2026-11-03T13:00:00+03:00'),
  locationFields: fields,
);

void main() {
  group('POST /bookings', () {
    test('sends the place fields with the backend\'s names, coordinates as JSON numbers, dates as ISO 8601, and the bearer token', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(201, {
          'id': 'b-1',
          'reference': 'BK-1',
          'status': 'OPEN',
          'location': {'cityId': 'c', 'cityNameEn': 'Riyadh', 'cityNameAr': 'الرياض', ..._fields},
        });
      });
      final view = await api.createBooking('tok', _request());
      expect(seen.method, 'POST');
      expect(seen.url.path, '/api/v1/bookings');
      expect(seen.headers['Authorization'], 'Bearer tok');
      final body = jsonDecode(seen.body) as Map<String, dynamic>;
      expect(body['latitude'], isA<double>());
      expect(body['longitude'], isA<double>());
      expect(body['latitude'], 24.7136);
      expect(body['preferredStartAt'], '2026-11-03T06:00:00.000Z');
      expect(body['addressLine'], _fields['addressLine']);
      expect(body['isUrgent'], false);
      // nothing about who the customer is: the backend takes that from the token
      for (final forbidden in ['userId', 'customerId', 'label', 'placeId', 'city']) {
        expect(body.containsKey(forbidden), isFalse, reason: forbidden);
      }
      expect(view.id, 'b-1');
      expect(view.location.latitude, 24.7136);
      expect(view.location.hasExactPoint, isTrue);
    });

    test('refuses to send a field the backend does not accept for the place', () {
      expect(() => _request({..._fields, 'label': 'Home'}).toJson(), throwsArgumentError);
      expect(() => _request({..._fields, 'placeId': 'abc'}).toJson(), throwsArgumentError);
    });

    test('a 400 keeps the backend\'s field messages (for example a bad latitude)', () async {
      final api = _api(
        (r) async => _json(400, {
          'statusCode': 400,
          'message': ['latitude must be a latitude string or number'],
          'error': 'Bad Request',
        }),
      );
      await expectLater(
        api.createBooking('tok', _request()),
        throwsA(
          isA<ApiException>().having((e) => e.status, 'status', 400).having((e) => e.fieldMessages, 'messages', [
            'latitude must be a latitude string or number',
          ]),
        ),
      );
    });
  });

  group('reading the place back', () {
    test('the owner gets the full place; the exact point is a pair of doubles', () async {
      final api = _api((r) async {
        expect(r.url.path, '/api/v1/bookings/b-1');
        return _json(200, {
          'id': 'b-1',
          'reference': 'BK-1',
          'status': 'OPEN',
          'location': {
            'cityId': 'c',
            'cityNameEn': 'Riyadh',
            'cityNameAr': 'الرياض',
            ..._fields,
            'latitude': 24,
            'longitude': 46,
          }, // whole numbers from JSON
        });
      });
      final loc = (await api.customerBooking('tok', 'b-1')).location;
      expect(loc.latitude, isA<double>());
      expect(loc.latitude, 24.0);
      expect(loc.building, '12, Unit 4, Floor 2');
      expect(loc.hasExactPoint, isTrue);
    });

    test('a worker before payment gets only the city and district: no point, and the app does not invent one', () async {
      final api = _api((r) async {
        expect(r.url.path, '/api/v1/workers/me/bookings/b-1');
        return _json(200, {
          'id': 'b-1',
          'reference': 'BK-1',
          'status': 'PAYMENT_PENDING',
          'location': {'cityId': 'c', 'cityNameEn': 'Riyadh', 'cityNameAr': 'الرياض', 'district': 'Al Olaya'},
        });
      });
      final v = await api.workerBooking('tok', 'b-1');
      expect(v.status, 'PAYMENT_PENDING');
      expect(v.location.district, 'Al Olaya');
      expect(v.location.addressLine, isNull);
      expect(v.location.latitude, isNull);
      expect(v.location.hasExactPoint, isFalse);
    });

    test('a worker after payment gets the exact point', () async {
      final api = _api(
        (r) async => _json(200, {
          'id': 'b-1',
          'reference': 'BK-1',
          'status': 'CONFIRMED',
          'location': {'cityId': 'c', ..._fields},
        }),
      );
      final v = await api.workerBooking('tok', 'b-1');
      expect(v.location.hasExactPoint, isTrue);
      expect(v.location.longitude, 46.6753);
    });

    test('missing, null or malformed coordinates mean no exact point (never 0,0)', () {
      for (final json in <Map<String, dynamic>>[
        {'cityId': 'c'},
        {'cityId': 'c', 'latitude': null, 'longitude': null},
        {'cityId': 'c', 'latitude': 24.7},
        {'cityId': 'c', 'latitude': '24.7', 'longitude': '46.6'},
        {'cityId': 'c', 'latitude': 95.0, 'longitude': 46.6},
        {'cityId': 'c', 'latitude': 24.7, 'longitude': 181.0},
      ]) {
        final loc = BookingLocation.fromJson(json);
        expect(loc.hasExactPoint, isFalse, reason: '$json');
      }
      expect(BookingLocation.fromJson(const {}).latitude, isNull);
    });

    test('the booking id is encoded in the path', () async {
      late Uri seen;
      final api = _api((r) async {
        seen = r.url;
        return _json(200, {'id': 'x', 'status': 'OPEN', 'location': {}});
      });
      await api.workerBooking('tok', 'a/../b');
      expect(seen.path, '/api/v1/workers/me/bookings/a%2F..%2Fb');
    });
  });

  group('my bookings and the catalog', () {
    test('GET /bookings sends the filters and parses the summaries', () async {
      late Uri seen;
      final api = _api((r) async {
        seen = r.url;
        expect(r.headers['Authorization'], 'Bearer tok');
        return _json(200, {
          'items': [
            {
              'id': 'b-1',
              'reference': 'BK-1',
              'status': 'OPEN',
              'service': {'id': 's1', 'slug': 'ac', 'nameEn': 'AC repair', 'nameAr': 'إصلاح مكيف'},
              'cityId': 'c1',
              'isUrgent': true,
              'preferredStartAt': '2026-11-03T06:00:00.000Z',
              'preferredEndAt': '2026-11-03T08:00:00.000Z',
              'expiresAt': '2026-11-05T06:00:00.000Z',
              'quoteCount': 2,
              'money': null,
              'createdAt': '2026-11-01T10:00:00.000Z',
            },
          ],
          'meta': {'page': 1, 'limit': 20, 'total': 1, 'totalPages': 1},
        });
      });
      final list = await api.myBookings('tok', statuses: ['OPEN', 'PAYMENT_PENDING'], createdFrom: DateTime.utc(2026, 11, 1, 9, 59), limit: 5);
      expect(seen.path, '/api/v1/bookings');
      expect(seen.queryParameters, {'limit': '5', 'sort': 'newest', 'status': 'OPEN,PAYMENT_PENDING', 'createdFrom': '2026-11-01T09:59:00.000Z'});
      expect(list.single.reference, 'BK-1');
      expect(list.single.serviceName(arabic: true), 'إصلاح مكيف');
      expect(list.single.serviceName(arabic: false), 'AC repair');
      expect(list.single.isUrgent, isTrue);
      expect(list.single.quoteCount, 2);
      expect(list.single.preferredStartAt, DateTime.utc(2026, 11, 3, 6));
    });

    test('a created booking carries its window and expiry back', () async {
      final api = _api(
        (r) async => _json(201, {
          'id': 'b-1',
          'reference': 'BK-1',
          'status': 'OPEN',
          'location': {'cityId': 'c'},
          'preferredStartAt': '2026-11-03T06:00:00.000Z',
          'preferredEndAt': '2026-11-03T08:00:00.000Z',
          'expiresAt': '2026-11-05T06:00:00.000Z',
        }),
      );
      final v = await api.createBooking('tok', _request());
      expect(v.preferredStartAt, DateTime.utc(2026, 11, 3, 6));
      expect(v.expiresAt, DateTime.utc(2026, 11, 5, 6));
    });

    test('the catalog keeps descriptions, slugs and icon keys', () async {
      final api = _api((r) async {
        if (r.url.path.endsWith('/cities')) {
          return _json(200, {
            'items': [
              {'id': 'c1', 'nameEn': 'Riyadh', 'nameAr': 'الرياض'},
            ],
          });
        }
        return _json(200, {
          'categories': [
            {
              'id': 'k1',
              'slug': 'ac',
              'nameEn': 'AC',
              'nameAr': 'تكييف',
              'iconKey': 'snowflake',
              'services': [
                {
                  'id': 's1',
                  'categoryId': 'k1',
                  'slug': 'ac-clean',
                  'nameEn': 'AC cleaning',
                  'nameAr': 'تنظيف',
                  'descriptionEn': 'Filters and coils',
                  'descriptionAr': null,
                },
              ],
            },
          ],
        });
      });
      final c = await api.catalog();
      expect(c.categories.single.iconKey, 'snowflake');
      final s = c.categories.single.services.single;
      expect(s.slug, 'ac-clean');
      expect(s.description(arabic: false), 'Filters and coils');
      expect(s.description(arabic: true), 'Filters and coils'); // no Arabic text: falls back to English
    });
  });
}
