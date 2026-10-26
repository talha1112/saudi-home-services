import 'dart:convert';
import 'dart:io';

import 'package:customer_app/features/location/models/picked_location.dart';
import 'package:customer_app/features/location/services/places_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _key = 'TEST-KEY-do-not-leak';

GooglePlacesService _service(
  Future<http.Response> Function(http.Request) h, {
  String key = _key,
}) => GooglePlacesService(
  apiKey: key,
  client: MockClient(h),
  timeout: const Duration(seconds: 2),
);

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  group('autocomplete (Places API New)', () {
    test(
      'posts to places:autocomplete with the key in a header, Saudi-only, the language, the session token and a location bias',
      () async {
        late http.Request seen;
        final s = _service((r) async {
          seen = r;
          return _json(200, {
            'suggestions': [
              {
                'placePrediction': {
                  'placeId': 'p1',
                  'text': {'text': 'King Fahd Road, Al Olaya, Riyadh'},
                  'structuredFormat': {
                    'mainText': {'text': 'King Fahd Road'},
                    'secondaryText': {'text': 'Al Olaya, Riyadh'},
                  },
                },
              },
              {'queryPrediction': {}}, // not a place: skipped
            ],
          });
        });
        final r = await s.autocomplete(
          'king fahd',
          sessionToken: 'tok-1',
          languageCode: 'ar',
          biasLatitude: 24.7,
          biasLongitude: 46.6,
        );
        expect(r.single.placeId, 'p1');
        expect(r.single.primary, 'King Fahd Road');
        expect(r.single.secondary, 'Al Olaya, Riyadh');
        expect(seen.method, 'POST');
        expect(
          seen.url.toString(),
          'https://places.googleapis.com/v1/places:autocomplete',
        );
        expect(seen.headers['X-Goog-Api-Key'], _key);
        expect(seen.url.toString(), isNot(contains(_key))); // not in the URL
        final body = jsonDecode(seen.body) as Map<String, dynamic>;
        expect(body['input'], 'king fahd');
        expect(body['sessionToken'], 'tok-1');
        expect(body['languageCode'], 'ar');
        expect(body['includedRegionCodes'], ['sa']);
        expect((body['locationBias'] as Map)['circle'], isNotNull);
      },
    );

    test('an empty answer is an empty list', () async {
      expect(
        await _service(
          (r) async => _json(200, <String, Object>{}),
        ).autocomplete('xyz', sessionToken: 't', languageCode: 'en'),
        isEmpty,
      );
    });
  });

  group('place details', () {
    test(
      'asks only for the fields it needs, with the same session token, and reads coordinates, address, district and city',
      () async {
        late http.Request seen;
        final s = _service((r) async {
          seen = r;
          return _json(200, {
            'id': 'p1',
            'formattedAddress': 'King Fahd Rd, Al Olaya, Riyadh 12211',
            'location': {'latitude': 24.7136, 'longitude': 46.6753},
            'addressComponents': [
              {
                'longText': 'Al Olaya',
                'types': ['sublocality_level_1', 'sublocality'],
              },
              {
                'longText': 'Riyadh',
                'types': ['locality'],
              },
            ],
          });
        });
        final d = await s.details(
          'p1',
          sessionToken: 'tok-1',
          languageCode: 'en',
        );
        expect(d.latitude, 24.7136);
        expect(d.longitude, 46.6753);
        expect(d.address, startsWith('King Fahd Rd'));
        expect(d.district, 'Al Olaya');
        expect(d.city, 'Riyadh');
        expect(seen.url.path, '/v1/places/p1');
        expect(seen.url.queryParameters['sessionToken'], 'tok-1');
        expect(
          seen.headers['X-Goog-FieldMask'],
          'id,displayName,formattedAddress,location,addressComponents',
        );
        expect(seen.headers['X-Goog-Api-Key'], _key);
      },
    );

    test('a place without coordinates is refused as invalid', () async {
      await expectLater(
        _service(
          (r) async => _json(200, {'id': 'p1', 'formattedAddress': 'x'}),
        ).details('p1', sessionToken: 't', languageCode: 'en'),
        throwsA(
          isA<PlacesException>().having(
            (e) => e.failure,
            'failure',
            PlacesFailure.invalid,
          ),
        ),
      );
    });
  });

  group('reverse geocoding (Geocoding API)', () {
    test(
      'reads the first result and picks the district and city from its components',
      () async {
        late http.Request seen;
        final s = _service((r) async {
          seen = r;
          return _json(200, {
            'status': 'OK',
            'results': [
              {
                'formatted_address': 'Anas Ibn Malik Rd, Al Malqa, Riyadh',
                'place_id': 'g1',
                'address_components': [
                  {
                    'long_name': 'Al Malqa',
                    'types': ['neighborhood', 'political'],
                  },
                  {
                    'long_name': 'Riyadh',
                    'types': ['locality', 'political'],
                  },
                ],
              },
            ],
          });
        });
        final r = (await s.reverseGeocode(24.8, 46.6, languageCode: 'ar'))!;
        expect(r.address, contains('Al Malqa'));
        expect(r.district, 'Al Malqa');
        expect(r.city, 'Riyadh');
        expect(r.placeId, 'g1');
        expect(seen.url.host, 'maps.googleapis.com');
        expect(seen.url.queryParameters['latlng'], '24.8,46.6');
        expect(seen.url.queryParameters['language'], 'ar');
        expect(seen.url.queryParameters['region'], 'sa');
      },
    );

    test('ZERO_RESULTS is "no address here", not an error', () async {
      expect(
        await _service(
          (r) async => _json(200, {'status': 'ZERO_RESULTS', 'results': []}),
        ).reverseGeocode(1, 1, languageCode: 'en'),
        isNull,
      );
    });

    test('quota, denied and invalid statuses map to their failures', () async {
      for (final entry in {
        'OVER_QUERY_LIMIT': PlacesFailure.quota,
        'OVER_DAILY_LIMIT': PlacesFailure.quota,
        'REQUEST_DENIED': PlacesFailure.denied,
        'INVALID_REQUEST': PlacesFailure.invalid,
        'UNKNOWN_ERROR': PlacesFailure.unavailable,
      }.entries) {
        await expectLater(
          _service(
            (r) async => _json(200, {'status': entry.key}),
          ).reverseGeocode(1, 1, languageCode: 'en'),
          throwsA(
            isA<PlacesException>().having(
              (e) => e.failure,
              entry.key,
              entry.value,
            ),
          ),
        );
      }
    });
  });

  group('errors', () {
    test('HTTP statuses map to failures', () async {
      for (final entry in {
        429: PlacesFailure.quota,
        403: PlacesFailure.denied,
        401: PlacesFailure.denied,
        400: PlacesFailure.invalid,
        503: PlacesFailure.unavailable,
        500: PlacesFailure.unavailable,
      }.entries) {
        await expectLater(
          _service(
            (r) async => http.Response('{}', entry.key),
          ).autocomplete('abc', sessionToken: 't', languageCode: 'en'),
          throwsA(
            isA<PlacesException>().having(
              (e) => e.failure,
              '${entry.key}',
              entry.value,
            ),
          ),
        );
      }
    });

    test('connection problems and timeouts are "network"', () async {
      await expectLater(
        _service(
          (r) async => throw const SocketException('down'),
        ).autocomplete('abc', sessionToken: 't', languageCode: 'en'),
        throwsA(
          isA<PlacesException>().having(
            (e) => e.failure,
            'failure',
            PlacesFailure.network,
          ),
        ),
      );
      await expectLater(
        _service(
          (r) async => throw http.ClientException('x'),
        ).reverseGeocode(1, 1, languageCode: 'en'),
        throwsA(
          isA<PlacesException>().having(
            (e) => e.failure,
            'failure',
            PlacesFailure.network,
          ),
        ),
      );
      final slow = GooglePlacesService(
        apiKey: _key,
        client: MockClient(
          (r) async => Future.delayed(
            const Duration(seconds: 1),
            () => http.Response('{}', 200),
          ),
        ),
        timeout: const Duration(milliseconds: 50),
      );
      await expectLater(
        slow.autocomplete('abc', sessionToken: 't', languageCode: 'en'),
        throwsA(
          isA<PlacesException>().having(
            (e) => e.failure,
            'failure',
            PlacesFailure.network,
          ),
        ),
      );
    });

    test(
      'without a key nothing is requested and the failure says so',
      () async {
        var calls = 0;
        final s = _service((r) async {
          calls++;
          return _json(200, {});
        }, key: '');
        for (final call in [
          () => s.autocomplete('abc', sessionToken: 't', languageCode: 'en'),
          () => s.details('p', sessionToken: 't', languageCode: 'en'),
          () => s.reverseGeocode(1, 1, languageCode: 'en'),
        ]) {
          await expectLater(
            call(),
            throwsA(
              isA<PlacesException>().having(
                (e) => e.failure,
                'failure',
                PlacesFailure.notConfigured,
              ),
            ),
          );
        }
        expect(calls, 0);
      },
    );

    test('the key never appears in an exception', () async {
      try {
        await _service(
          (r) async => http.Response('{}', 403),
        ).reverseGeocode(1, 1, languageCode: 'en');
        fail('should throw');
      } on PlacesException catch (e) {
        expect(e.toString(), isNot(contains(_key)));
      }
    });
  });

  test('session tokens are UUID-shaped and different each time', () {
    final a = newSessionToken();
    final b = newSessionToken();
    expect(
      a,
      matches(
        RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ),
      ),
    );
    expect(a, isNot(b));
  });

  group('PickedLocation -> booking fields', () {
    test(
      'maps onto the backend booking location fields with their length limits',
      () {
        final f = const PickedLocation(
          latitude: 24.7,
          longitude: 46.6,
          address: '  King Fahd Rd, Al Olaya  ',
          district: 'Al Olaya',
          building: '12',
          unit: '4',
          floor: '2',
          notes: 'Ring the bell',
          label: 'Home',
        ).toBookingFields();
        expect(f, {
          'addressLine': 'King Fahd Rd, Al Olaya',
          'district': 'Al Olaya',
          'building': '12, Unit 4, Floor 2',
          'locationNotes': 'Ring the bell',
          'latitude': 24.7,
          'longitude': 46.6,
        });
        expect(f.containsKey('label'), isFalse); // the label stays on the phone
      },
    );

    test('omits empty optional fields and truncates to the backend limits', () {
      final f = PickedLocation(
        latitude: 1,
        longitude: 2,
        address: 'x' * 400,
        notes: 'n' * 900,
        building: 'b' * 300,
      ).toBookingFields();
      expect((f['addressLine']! as String).length, 255);
      expect((f['locationNotes']! as String).length, 500);
      expect((f['building']! as String).length, 120);
      expect(f.containsKey('district'), isFalse);
    });

    test('coordinate validation', () {
      expect(PickedLocation.validCoordinates(24.7, 46.6), isTrue);
      expect(PickedLocation.validCoordinates(91, 0), isFalse);
      expect(PickedLocation.validCoordinates(0, 181), isFalse);
      expect(PickedLocation.validCoordinates(double.nan, 0), isFalse);
    });
  });
}
