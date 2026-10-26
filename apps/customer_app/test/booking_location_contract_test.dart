import 'dart:convert';
import 'dart:io';

import 'package:customer_app/features/location/models/picked_location.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';

/// The contract between the location picker and the backend's `POST /bookings`.
///
/// The expected JSON lives in the backend repository's test fixtures, and the backend's `booking-location` integration spec posts exactly
/// that JSON to the real API and checks what is stored and returned. This test checks that the app produces exactly that JSON, so a change
/// on either side breaks a test instead of a booking.
Map<String, dynamic> _fixture() {
  final file = File(
    '../backend/test/fixtures/picked-location-booking-fields.json',
  );
  return (jsonDecode(file.readAsStringSync()) as Map<String, dynamic>)['fields']
      as Map<String, dynamic>;
}

/// The fields the backend's CreateBookingDto accepts for the place (and nothing else may be sent).
const _dtoLocationFields = {
  'addressLine',
  'district',
  'building',
  'locationNotes',
  'latitude',
  'longitude',
};

const _confirmed = PickedLocation(
  latitude: 24.7136,
  longitude: 46.6753,
  address: 'King Fahd Rd, Al Olaya, Riyadh 12211',
  placeId: 'ChIJ-not-sent',
  district: 'Al Olaya',
  city: 'Riyadh',
  building: '12',
  unit: '4',
  floor: '2',
  label: 'Home',
  notes: 'Ring the bell twice',
);

void main() {
  test('the fixture exists and the app produces exactly that JSON', () {
    final produced =
        jsonDecode(jsonEncode(_confirmed.toBookingFields()))
            as Map<String, dynamic>;
    expect(produced, _fixture());
  });

  test(
    'only fields the backend accepts for the place are sent: no label, place id or city, and no user id',
    () {
      final keys = _confirmed.toBookingFields().keys.toSet();
      expect(keys.difference(_dtoLocationFields), isEmpty);
      for (final never in [
        'label',
        'placeId',
        'city',
        'unit',
        'floor',
        'userId',
        'customerId',
      ]) {
        expect(keys.contains(never), isFalse, reason: never);
      }
    },
  );

  test('coordinates are numbers (not strings) and inside the valid range', () {
    final f = _confirmed.toBookingFields();
    expect(f['latitude'], isA<double>());
    expect(f['longitude'], isA<double>());
    expect(
      PickedLocation.validCoordinates(
        f['latitude']! as double,
        f['longitude']! as double,
      ),
      isTrue,
    );
  });

  test('the backend\'s length limits hold even for very long input', () {
    final long = PickedLocation(
      latitude: 24.7,
      longitude: 46.6,
      address: 'a' * 400,
      district: 'd' * 300,
      building: 'b' * 300,
      unit: 'u' * 300,
      floor: 'f' * 300,
      notes: 'n' * 900,
    );
    final f = long.toBookingFields();
    expect((f['addressLine']! as String).length, lessThanOrEqualTo(255));
    expect((f['district']! as String).length, lessThanOrEqualTo(120));
    expect((f['building']! as String).length, lessThanOrEqualTo(120));
    expect((f['locationNotes']! as String).length, lessThanOrEqualTo(500));
  });

  test('a minimal place (address only) sends no empty optional fields', () {
    final f = const PickedLocation(
      latitude: 24.7,
      longitude: 46.6,
      address: 'Villa 7, Al Narjis',
    ).toBookingFields();
    expect(f.keys.toSet(), {'addressLine', 'latitude', 'longitude'});
  });

  test(
    'it goes into the shared booking request unchanged, and the request body is what the API expects',
    () {
      final request = CreateBookingRequest(
        serviceId: 's',
        cityId: 'c',
        problemDescription:
            'The kitchen outlet sparks whenever I plug something in.',
        preferredStartAt: DateTime.utc(2026, 11, 3, 6),
        preferredEndAt: DateTime.utc(2026, 11, 3, 10),
        locationFields: _confirmed.toBookingFields(),
      );
      final body =
          jsonDecode(jsonEncode(request.toJson())) as Map<String, dynamic>;
      for (final entry in _fixture().entries) {
        expect(body[entry.key], entry.value, reason: entry.key);
      }
    },
  );
}
