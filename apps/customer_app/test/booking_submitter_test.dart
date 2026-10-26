import 'dart:convert';

import 'package:customer_app/features/booking/logic/booking_schedule.dart';
import 'package:customer_app/features/booking/logic/booking_submitter.dart';
import 'package:customer_app/features/location/models/picked_location.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

/// The one place the app talks to `POST /bookings`: what it sends, what it refuses to send, and that a retry never makes a second booking.
/// The backend is the shared fake from hs_client/testing.dart (no idempotency key exists on the real endpoint either).
const _pin = PickedLocation(
  latitude: 24.7136,
  longitude: 46.6753,
  address: 'King Fahd Rd, Al Olaya, Riyadh 12211',
  district: 'Al Olaya',
  building: '12',
  unit: '4',
  notes: 'Ring the bell twice',
);

// 13:00 in Saudi Arabia.
final _now = DateTime.utc(2026, 11, 1, 10);

BookingDraft _draft({
  PickedLocation? location = _pin,
  String? serviceId = 'svc-ac',
  String? cityId = 'city-ruh',
  String description = '  Two split units, weak cooling and dripping water  ',
  bool asap = false,
  int dayIndex = 1,
  int slotIndex = 4,
}) => BookingDraft(
  serviceId: serviceId,
  cityId: cityId,
  description: description,
  location: location,
  asap: asap,
  dayIndex: dayIndex,
  slotIndex: slotIndex,
);

class _Rig {
  _Rig(this.kit, this.submitter, this.setNow);
  final TestHsClient kit;
  final BookingSubmitter submitter;
  final void Function(DateTime) setNow;
  FakeApi get api => kit.api;
}

Future<_Rig> _rig({bool signedIn = true}) async {
  final kit = TestHsClient();
  if (signedIn) {
    await kit.client.auth.sendCode('+966551234567');
    await kit.client.auth.submitCode('123456');
  }
  var now = _now;
  final submitter = BookingSubmitter(
    api: kit.api,
    auth: kit.client.auth,
    clock: () => now,
  );
  addTearDown(() {
    submitter.dispose();
    kit.client.auth.dispose();
  });
  return _Rig(kit, submitter, (t) => now = t);
}

ApiException _api(
  int status,
  String code, {
  String? message,
  List<String> fields = const [],
}) => ApiException(
  status: status,
  code: code,
  message: message,
  fieldMessages: fields,
);

void main() {
  group('the request that is sent', () {
    test(
      'uses the backend field names, the catalog ids, a trimmed description and ISO UTC times',
      () async {
        final r = await _rig();
        final booking = await r.submitter.submit(_draft());

        expect(booking, isNotNull);
        final sent = r.api.createdBookings.single;
        expect(sent.serviceId, 'svc-ac');
        expect(sent.cityId, 'city-ruh');
        expect(
          sent.problemDescription,
          'Two split units, weak cooling and dripping water',
        );
        // tomorrow (2 Nov), the 6:00 PM slot in Saudi time, as a two-hour window in UTC
        expect(sent.preferredStartAt, DateTime.utc(2026, 11, 2, 15));
        expect(sent.preferredEndAt, DateTime.utc(2026, 11, 2, 17));
        expect(sent.isUrgent, isFalse);

        final json =
            jsonDecode(jsonEncode(sent.toJson())) as Map<String, dynamic>;
        expect(json['serviceId'], 'svc-ac');
        expect(json['cityId'], 'city-ruh');
        expect(
          json['problemDescription'],
          'Two split units, weak cooling and dripping water',
        );
        expect(json['preferredStartAt'], '2026-11-02T15:00:00.000Z');
        expect(json['preferredEndAt'], '2026-11-02T17:00:00.000Z');
        expect(json['isUrgent'], false);
        // nothing the client must not decide: no owner, status, role or price
        for (final never in [
          'customerId',
          'userId',
          'status',
          'role',
          'price',
          'paymentMethod',
        ]) {
          expect(json.containsKey(never), isFalse, reason: never);
        }
      },
    );

    test(
      'the place is exactly PickedLocation.toBookingFields(), with numeric coordinates',
      () async {
        final r = await _rig();
        await r.submitter.submit(_draft());

        final sent = r.api.createdBookings.single;
        expect(sent.locationFields, _pin.toBookingFields());
        final json =
            jsonDecode(jsonEncode(sent.toJson())) as Map<String, dynamic>;
        expect(json['latitude'], isA<num>());
        expect(json['longitude'], isA<num>());
        expect(json['latitude'], 24.7136);
        expect(json['longitude'], 46.6753);
        expect(json['addressLine'], _pin.address);
        expect(json['district'], 'Al Olaya');
      },
    );

    test(
      '"as soon as possible" is urgent, starts after the lead time and lasts two hours',
      () async {
        final r = await _rig();
        await r.submitter.submit(_draft(asap: true, slotIndex: -1));

        final sent = r.api.createdBookings.single;
        expect(sent.isUrgent, isTrue);
        expect(
          sent.preferredStartAt.isAfter(
            _now.add(const Duration(minutes: kMinLeadMinutes)),
          ),
          isTrue,
        );
        expect(
          sent.preferredEndAt.difference(sent.preferredStartAt),
          const Duration(hours: 2),
        );
        expect(sent.preferredStartAt.isUtc, isTrue);
      },
    );

    test(
      'the confirmation comes from the backend answer: id, reference, status and window',
      () async {
        final r = await _rig();
        final booking = (await r.submitter.submit(_draft()))!;

        expect(booking.id, 'booking-1');
        expect(booking.reference, 'HS-1');
        expect(booking.status, 'OPEN');
        expect(booking.preferredStartAt, DateTime.utc(2026, 11, 2, 15));
        expect(r.submitter.created, same(booking));
        expect(r.submitter.failure, isNull);
      },
    );
  });

  group('nothing is sent unless it is complete', () {
    test('no location: not sent, and never defaulted to 0,0', () async {
      final r = await _rig();
      final result = await r.submitter.submit(_draft(location: null));

      expect(result, isNull);
      expect(r.submitter.failure!.problem, SubmitProblem.incomplete);
      expect(r.submitter.failure!.missing, ['location']);
      expect(r.api.createdBookings, isEmpty);
      expect(r.api.calls, isNot(contains('createBooking')));
    });

    test('coordinates that are not real are refused instead of sent', () async {
      final r = await _rig();
      for (final bad in [
        const PickedLocation(
          latitude: double.nan,
          longitude: 46.6,
          address: 'x',
        ),
        const PickedLocation(
          latitude: 24.7,
          longitude: double.infinity,
          address: 'x',
        ),
        const PickedLocation(latitude: 91, longitude: 46.6, address: 'x'),
        const PickedLocation(latitude: 24.7, longitude: -181, address: 'x'),
      ]) {
        r.submitter.reset();
        expect(await r.submitter.submit(_draft(location: bad)), isNull);
        expect(r.submitter.failure!.missing, ['location']);
      }
      expect(r.api.createdBookings, isEmpty);
    });

    test('each missing choice is named', () async {
      final r = await _rig();
      final cases = <String, BookingDraft>{
        'service': _draft(serviceId: null),
        'city': _draft(cityId: null),
        'description': _draft(description: 'too short'),
        'schedule': _draft(slotIndex: -1),
      };
      for (final c in cases.entries) {
        expect(await r.submitter.submit(c.value), isNull, reason: c.key);
        expect(
          r.submitter.failure!.problem,
          SubmitProblem.incomplete,
          reason: c.key,
        );
        expect(r.submitter.failure!.missing, [c.key], reason: c.key);
      }
      expect(r.api.createdBookings, isEmpty);
    });

    test(
      'the description must be 10 to 2000 characters after trimming',
      () async {
        final r = await _rig();
        expect(
          await r.submitter.submit(_draft(description: '         123456789  ')),
          isNull,
        );
        expect(
          await r.submitter.submit(_draft(description: 'x' * 2001)),
          isNull,
        );
        expect(r.api.createdBookings, isEmpty);
        expect(
          await r.submitter.submit(_draft(description: '1234567890')),
          isNotNull,
        );
        expect(r.api.createdBookings, hasLength(1));
      },
    );

    test('a time that has become too soon is caught before sending', () async {
      final r = await _rig();
      r.setNow(
        DateTime.utc(2026, 11, 2, 14, 45),
      ); // 17:45 Saudi; the 6:00 PM slot today is 15 minutes away
      final result = await r.submitter.submit(_draft(dayIndex: 0));

      expect(result, isNull);
      expect(r.submitter.failure!.problem, SubmitProblem.timePassed);
      expect(r.api.createdBookings, isEmpty);
    });

    test(
      'signed out: nothing is sent and the reason is "not signed in"',
      () async {
        final r = await _rig(signedIn: false);
        expect(await r.submitter.submit(_draft()), isNull);
        expect(r.submitter.failure!.problem, SubmitProblem.notSignedIn);
        expect(r.api.createdBookings, isEmpty);
      },
    );
  });

  group('double taps and retries never make two bookings', () {
    test(
      'taps while the request is running share it: one request, one answer',
      () async {
        final r = await _rig();
        final first = r.submitter.submit(_draft());
        final second = r.submitter.submit(_draft());
        final third = r.submitter.submit(_draft());
        expect(r.submitter.busy, isTrue);

        final results = await Future.wait([first, second, third]);
        expect(r.api.createdBookings, hasLength(1));
        expect(r.api.bookingList, hasLength(1));
        expect(results.map((b) => b!.id).toSet(), {'booking-1'});
        expect(r.submitter.busy, isFalse);
      },
    );

    test(
      'after success, submitting again returns the same booking and sends nothing',
      () async {
        final r = await _rig();
        final a = await r.submitter.submit(_draft());
        final b = await r.submitter.submit(_draft());
        final c = await r.submitter.submit(
          _draft(description: 'A completely different job'),
        );

        expect(identical(a, b) && identical(b, c), isTrue);
        expect(r.api.createdBookings, hasLength(1));
      },
    );

    test(
      'reset starts a new booking; it cannot interrupt one that is running',
      () async {
        final r = await _rig();
        await r.submitter.submit(_draft());
        r.submitter.reset();
        expect(r.submitter.created, isNull);
        await r.submitter.submit(_draft());
        expect(r.api.createdBookings, hasLength(2));

        r.submitter.reset();
        final running = r.submitter.submit(_draft());
        r.submitter.reset(); // ignored while in flight
        expect(r.submitter.busy, isTrue);
        expect((await running)!.id, 'booking-3');
        expect(r.submitter.created, isNotNull);
      },
    );

    test(
      'the answer was lost but the server had created the booking: the retry finds it instead of sending again',
      () async {
        final r = await _rig();
        r.api.failAfterCreating = _api(0, 'NETWORK');

        expect(await r.submitter.submit(_draft()), isNull);
        expect(r.submitter.failure!.problem, SubmitProblem.network);
        expect(r.api.bookingList, hasLength(1)); // the server did create it

        final booking = await r.submitter.submit(_draft());
        expect(booking!.id, 'booking-1');
        expect(r.api.createdBookings, hasLength(1), reason: 'no second POST');
        expect(r.api.bookingList, hasLength(1));
        expect(r.api.lastStatuses, ['OPEN']);
        expect(r.api.lastCreatedFrom, isNotNull);
        expect(booking.reference, 'HS-1');
        expect(booking.status, 'OPEN');
      },
    );

    test('a 500 is treated the same way (it may have been created)', () async {
      final r = await _rig();
      r.api.failAfterCreating = _api(502, 'BAD_GATEWAY');
      expect(await r.submitter.submit(_draft()), isNull);
      expect(r.submitter.failure!.problem, SubmitProblem.unavailable);
      expect((await r.submitter.submit(_draft()))!.id, 'booking-1');
      expect(r.api.createdBookings, hasLength(1));
    });

    test(
      'it really was not created: the retry looks first, then sends once more, and the booking exists once',
      () async {
        final r = await _rig();
        r.api.createBookingResult = _api(0, 'NETWORK');
        expect(await r.submitter.submit(_draft()), isNull);

        r.api.createBookingResult = null;
        r.setNow(_now.add(const Duration(minutes: 3)));
        final booking = await r.submitter.submit(_draft());

        expect(booking, isNotNull);
        expect(r.api.calls, contains('myBookings'), reason: 'it looked first');
        expect(r.api.createdBookings, hasLength(2));
        expect(
          r.api.bookingList,
          hasLength(1),
          reason: 'only the second reached the server',
        );
        // a chosen time slot is the same request both times
        expect(
          r.api.createdBookings[1].preferredStartAt,
          r.api.createdBookings[0].preferredStartAt,
        );
      },
    );

    test(
      '"as soon as possible" retried later is still a valid time (never sent in the past)',
      () async {
        final r = await _rig();
        r.api.createBookingResult = _api(0, 'NETWORK');
        await r.submitter.submit(_draft(asap: true, slotIndex: -1));

        r.api.createBookingResult = null;
        final later = _now.add(const Duration(minutes: 20));
        r.setNow(later);
        expect(
          await r.submitter.submit(_draft(asap: true, slotIndex: -1)),
          isNotNull,
        );
        expect(
          r.api.createdBookings[1].preferredStartAt.isAfter(
            later.add(const Duration(minutes: kMinLeadMinutes)),
          ),
          isTrue,
        );
      },
    );

    test(
      'if it cannot check whether the first one exists, it sends nothing',
      () async {
        final r = await _rig();
        r.api.failAfterCreating = _api(0, 'NETWORK');
        await r.submitter.submit(_draft());

        r.api.myBookingsResult = _api(0, 'NETWORK');
        expect(await r.submitter.submit(_draft()), isNull);
        expect(r.submitter.failure!.problem, SubmitProblem.network);
        expect(
          r.api.createdBookings,
          hasLength(1),
          reason: 'still only the first request',
        );

        r.api.myBookingsResult = null;
        expect((await r.submitter.submit(_draft()))!.id, 'booking-1');
        expect(r.api.createdBookings, hasLength(1));
      },
    );

    test(
      'a request the server refused is not "maybe created": the retry does not look anything up',
      () async {
        final r = await _rig();
        r.api.createBookingResult = _api(
          400,
          'VALIDATION_ERROR',
          fields: ['problemDescription is too short'],
        );
        expect(await r.submitter.submit(_draft()), isNull);

        r.api.createBookingResult = null;
        expect(await r.submitter.submit(_draft()), isNotNull);
        expect(r.api.calls, isNot(contains('myBookings')));
        expect(r.api.createdBookings, hasLength(2));
        expect(r.api.bookingList, hasLength(1));
      },
    );

    test(
      'changing the request after an unanswered attempt is a new request, not an adoption of the old one',
      () async {
        final r = await _rig();
        r.api.failAfterCreating = _api(0, 'NETWORK');
        await r.submitter.submit(_draft());

        final other = await r.submitter.submit(
          _draft(description: 'A different problem entirely'),
        );
        expect(other, isNotNull);
        expect(r.api.calls, isNot(contains('myBookings')));
        expect(r.api.createdBookings, hasLength(2));
      },
    );
  });

  group('errors are mapped to something the customer can act on', () {
    Future<SubmitFailure> failWith(ApiException e) async {
      final r = await _rig();
      // a 401 makes the session layer try one refresh; here the server refuses that too
      r.api.refreshResults.add(_api(401, 'UNAUTHORIZED'));
      r.api.createBookingResult = e;
      expect(await r.submitter.submit(_draft()), isNull);
      expect(r.submitter.created, isNull);
      return r.submitter.failure!;
    }

    test('schedule refused by the backend keeps its message', () async {
      final f = await failWith(
        _api(400, 'INVALID_SCHEDULE', message: 'Start time is too soon'),
      );
      expect(f.problem, SubmitProblem.scheduleRejected);
      expect(f.message, 'Start time is too soon');
    });

    test('service, city and open-request limit', () async {
      expect(
        (await failWith(_api(404, 'INVALID_SERVICE'))).problem,
        SubmitProblem.serviceUnavailable,
      );
      expect(
        (await failWith(_api(404, 'INVALID_CITY'))).problem,
        SubmitProblem.cityUnavailable,
      );
      expect(
        (await failWith(_api(409, 'BOOKING_LIMIT'))).problem,
        SubmitProblem.limitReached,
      );
    });

    test('field validation carries the backend messages', () async {
      final f = await failWith(
        _api(
          400,
          'VALIDATION_ERROR',
          fields: ['problemDescription must be longer than 9 characters'],
        ),
      );
      expect(f.problem, SubmitProblem.validation);
      expect(f.fieldMessages, [
        'problemDescription must be longer than 9 characters',
      ]);
    });

    test(
      'no connection, busy server, rejected session, anything else',
      () async {
        expect(
          (await failWith(_api(0, 'NETWORK'))).problem,
          SubmitProblem.network,
        );
        expect(
          (await failWith(_api(429, 'RATE_LIMITED'))).problem,
          SubmitProblem.unavailable,
        );
        expect(
          (await failWith(_api(503, 'UNAVAILABLE'))).problem,
          SubmitProblem.unavailable,
        );
        expect(
          (await failWith(_api(401, 'UNAUTHORIZED'))).problem,
          SubmitProblem.notSignedIn,
        );
        expect(
          (await failWith(_api(403, 'FORBIDDEN'))).problem,
          SubmitProblem.other,
        );
      },
    );

    test(
      'after a failure the customer can fix things and send again',
      () async {
        final r = await _rig();
        r.api.createBookingResult = _api(409, 'BOOKING_LIMIT');
        expect(await r.submitter.submit(_draft()), isNull);
        expect(r.submitter.failure!.problem, SubmitProblem.limitReached);

        r.api.createBookingResult = null;
        expect(await r.submitter.submit(_draft()), isNotNull);
        expect(r.submitter.failure, isNull);
      },
    );
  });
}
