import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h) =>
    HsApi(baseUrl: 'https://api.example.com/api/v1', client: MockClient(h), clock: () => DateTime.utc(2026, 11, 1));
http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

// ---- payloads shaped exactly like the backend's WorkerRequestSummaryDto / WorkerBookingDto / QuoteForWorkerDto

Map<String, dynamic> _money({int price = 25000}) => {
  'currency': 'SAR',
  'serviceHalalas': price,
  'vatHalalas': 3750,
  'totalHalalas': price + 3750,
  'vatRateBps': 1500,
  'commissionHalalas': 3750,
  'payoutHalalas': price - 3750,
  'commissionRateBps': 1500,
};

Map<String, dynamic> _quote({String status = 'SUBMITTED'}) => {
  'id': 'q-1',
  'bookingId': 'b-1',
  'bookingReference': 'HS-1',
  'status': status,
  'version': 1,
  'money': _money(),
  'proposedStartAt': '2026-11-03T15:00:00.000Z',
  'proposedEndAt': '2026-11-03T17:00:00.000Z',
  'estimatedDurationMinutes': 90,
  'message': 'Includes parts',
  'validUntil': '2026-11-02T10:00:00.000Z',
  'isExpired': false,
  'createdAt': '2026-11-01T10:00:00.000Z',
};

Map<String, dynamic> _request({Object? myQuote}) => {
  'id': 'b-1',
  'reference': 'HS-1',
  'status': 'OPEN',
  'service': {'id': 's-1', 'slug': 'ac-repair', 'nameEn': 'AC repair', 'nameAr': 'إصلاح المكيفات'},
  // before payment: city and district only
  'location': {'cityId': 'c-1', 'cityNameEn': 'Riyadh', 'cityNameAr': 'الرياض', 'district': 'Al Olaya'},
  'isUrgent': true,
  'preferredStartAt': '2026-11-03T15:00:00.000Z',
  'preferredEndAt': '2026-11-03T17:00:00.000Z',
  'expiresAt': '2026-11-03T10:00:00.000Z',
  'myQuote': myQuote,
  'createdAt': '2026-11-01T09:00:00.000Z',
};

Map<String, dynamic> _job({required String status, required bool paid}) => {
  ..._request(myQuote: _quote(status: 'ACCEPTED')),
  'status': status,
  'location': {
    'cityId': 'c-1',
    'cityNameEn': 'Riyadh',
    'cityNameAr': 'الرياض',
    'district': 'Al Olaya',
    if (paid) ...{
      'addressLine': 'King Fahd Rd, Al Olaya',
      'building': '12',
      'locationNotes': 'Ring twice',
      'latitude': 24.7136,
      'longitude': 46.6753,
    },
  },
  'problemDescription': 'Two units, weak cooling',
  'money': _money(),
  'photos': [
    {'id': 'p-1'},
  ],
  if (paid) ...{'customerName': 'Sara', 'customerPhone': '+966500000000'},
  'startedAt': null,
  'completedAt': null,
};

Map<String, dynamic> _page(List<Object> items) => {
  'items': items,
  'meta': {'page': 1, 'limit': 20, 'total': items.length, 'totalPages': 1},
};

void main() {
  group('open requests', () {
    test('GET /workers/me/requests: path, bearer token, paging and the parsed request', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, _page([_request(), _request(myQuote: _quote())..['id'] = 'b-2']));
      });
      final page = await api.workerRequests('tok', limit: 10, sort: 'soonest');

      expect(seen.method, 'GET');
      expect(seen.url.path, '/api/v1/workers/me/requests');
      expect(seen.url.queryParameters, {'page': '1', 'limit': '10', 'sort': 'soonest'});
      expect(seen.headers['Authorization'], 'Bearer tok');
      expect(page.total, 2);
      expect(page.hasMore, isFalse);

      final r = page.items.first;
      expect(r.id, 'b-1');
      expect(r.reference, 'HS-1');
      expect(r.status, 'OPEN');
      expect(r.service.id, 's-1');
      expect(r.service.name(arabic: false), 'AC repair');
      expect(r.service.name(arabic: true), 'إصلاح المكيفات');
      expect(r.isUrgent, isTrue);
      expect(r.preferredStartAt, DateTime.utc(2026, 11, 3, 15));
      expect(r.expiresAt, DateTime.utc(2026, 11, 3, 10));
      expect(r.myQuote, isNull);
      expect(page.items[1].myQuote!.id, 'q-1');
    });

    test('an open request carries the city and district only: no street, no coordinates, no customer', () async {
      final api = _api((r) async => _json(200, _page([_request()])));
      final r = (await api.workerRequests('tok')).items.single;

      expect(r.location.cityNameEn, 'Riyadh');
      expect(r.location.district, 'Al Olaya');
      expect(r.location.addressLine, isNull);
      expect(r.location.building, isNull);
      expect(r.location.latitude, isNull);
      expect(r.location.longitude, isNull);
      expect(r.location.hasExactPoint, isFalse);
    });

    test('the detail adds the description and the number of photos', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {
          ..._request(),
          'problemDescription': 'Water drips from the indoor unit',
          'photos': [
            {'id': 'p-1'},
            {'id': 'p-2'},
          ],
        });
      });
      final r = await api.workerRequest('tok', 'b-1');
      expect(seen.url.path, '/api/v1/workers/me/requests/b-1');
      expect(r.problemDescription, 'Water drips from the indoor unit');
      expect(r.photoCount, 2);
    });

    test('an empty list is an empty page, not an error', () async {
      final api = _api((r) async => _json(200, _page([])));
      final page = await api.workerRequests('tok');
      expect(page.items, isEmpty);
      expect(page.total, 0);
    });

    test('a request the worker is not eligible for is a 404 ApiException', () async {
      final api = _api((r) async => _json(404, {'statusCode': 404, 'code': 'NOT_FOUND', 'message': 'Request not found'}));
      await expectLater(api.workerRequest('tok', 'b-9'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });
  });

  group('quotes', () {
    test('POST …/quote sends the worker\'s own price in halalas and ISO UTC times, and only that', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(201, _quote());
      });
      final quote = await api.submitQuote(
        'tok',
        'b-1',
        SubmitQuoteRequest(
          priceHalalas: 25000,
          proposedStartAt: DateTime.parse('2026-11-03T18:00:00+03:00'),
          proposedEndAt: DateTime.parse('2026-11-03T20:00:00+03:00'),
          estimatedDurationMinutes: 90,
          message: '  Includes parts  ',
          validForHours: 24,
        ),
      );
      final body = jsonDecode(seen.body) as Map<String, dynamic>;
      expect(seen.method, 'POST');
      expect(seen.url.path, '/api/v1/workers/me/requests/b-1/quote');
      expect(body, {
        'priceHalalas': 25000,
        'proposedStartAt': '2026-11-03T15:00:00.000Z',
        'proposedEndAt': '2026-11-03T17:00:00.000Z',
        'estimatedDurationMinutes': 90,
        'message': 'Includes parts',
        'validForHours': 24,
      });
      for (final never in ['vat', 'commission', 'total', 'payout', 'workerId', 'status']) {
        expect(body.keys.any((k) => k.toLowerCase().contains(never.toLowerCase())), isFalse, reason: never);
      }
      // the amounts come back computed by the server
      expect(quote.money.serviceHalalas, 25000);
      expect(quote.money.vatHalalas, 3750);
      expect(quote.money.totalHalalas, 28750);
      expect(quote.money.payoutHalalas, 21250);
      expect(quote.money.payout, 212.5);
      expect(quote.status, 'SUBMITTED');
      expect(quote.isLive, isTrue);
      expect(quote.estimatedDurationMinutes, 90);
    });

    test('optional fields are left out when not given', () {
      final json = SubmitQuoteRequest(
        priceHalalas: 9900,
        proposedStartAt: DateTime.utc(2026, 11, 3),
        proposedEndAt: DateTime.utc(2026, 11, 3, 2),
        message: '   ',
      ).toJson();
      expect(json.keys.toSet(), {'priceHalalas', 'proposedStartAt', 'proposedEndAt'});
    });

    test('server refusals keep their code and details', () async {
      final api = _api(
        (r) async => _json(400, {
          'statusCode': 400,
          'code': 'PRICE_BELOW_MINIMUM',
          'message': 'The price is below the minimum service charge',
          'details': {'minServiceChargeHalalas': 9900},
        }),
      );
      await expectLater(
        api.submitQuote(
          'tok',
          'b-1',
          SubmitQuoteRequest(priceHalalas: 100, proposedStartAt: DateTime.utc(2026, 11, 3), proposedEndAt: DateTime.utc(2026, 11, 3, 2)),
        ),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'PRICE_BELOW_MINIMUM').having((e) => e.details?['minServiceChargeHalalas'], 'min', 9900),
        ),
      );
    });

    test('a second quote on the same request is a 409 QUOTE_EXISTS', () async {
      final api = _api((r) async => _json(409, {'statusCode': 409, 'code': 'QUOTE_EXISTS', 'message': 'You already quoted'}));
      await expectLater(
        api.submitQuote(
          'tok',
          'b-1',
          SubmitQuoteRequest(priceHalalas: 12000, proposedStartAt: DateTime.utc(2026, 11, 3), proposedEndAt: DateTime.utc(2026, 11, 3, 2)),
        ),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'QUOTE_EXISTS')),
      );
    });

    test('GET /workers/me/quotes filters by status; withdraw is a POST', () async {
      final seen = <http.Request>[];
      final api = _api((r) async {
        seen.add(r);
        return r.method == 'GET' ? _json(200, _page([_quote()])) : _json(200, _quote(status: 'WITHDRAWN'));
      });
      final page = await api.workerQuotes('tok', statuses: ['SUBMITTED', 'ACCEPTED']);
      expect(seen[0].url.queryParameters['status'], 'SUBMITTED,ACCEPTED');
      expect(page.items.single.bookingReference, 'HS-1');
      final withdrawn = await api.withdrawWorkerQuote('tok', 'q-1');
      expect(seen[1].method, 'POST');
      expect(seen[1].url.path, '/api/v1/workers/me/quotes/q-1/withdraw');
      expect(withdrawn.status, 'WITHDRAWN');
      expect(withdrawn.isLive, isFalse);
    });
  });

  group('assigned jobs', () {
    test('a job whose customer has not paid has the city and district only, and no customer contact', () async {
      final api = _api((r) async => _json(200, _page([_job(status: 'PAYMENT_PENDING', paid: false)])));
      final job = (await api.workerJobs('tok', statuses: ['PAYMENT_PENDING'])).items.single;

      expect(job.status, 'PAYMENT_PENDING');
      expect(job.location.district, 'Al Olaya');
      expect(job.location.addressLine, isNull);
      expect(job.location.latitude, isNull);
      expect(job.location.hasExactPoint, isFalse);
      expect(job.customerName, isNull);
      expect(job.customerPhone, isNull);
      expect(job.canStart, isFalse);
    });

    test('a paid job carries the full address, the exact point and the customer contact, exactly as sent', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, _job(status: 'CONFIRMED', paid: true));
      });
      final job = await api.workerJob('tok', 'b-1');

      expect(seen.url.path, '/api/v1/workers/me/bookings/b-1');
      expect(job.location.addressLine, 'King Fahd Rd, Al Olaya');
      expect(job.location.building, '12');
      expect(job.location.locationNotes, 'Ring twice');
      expect(job.location.latitude, 24.7136);
      expect(job.location.longitude, 46.6753);
      expect(job.location.hasExactPoint, isTrue);
      expect(job.customerName, 'Sara');
      expect(job.customerPhone, '+966500000000');
      expect(job.money!.payoutHalalas, 21250);
      expect(job.problemDescription, 'Two units, weak cooling');
      expect(job.photoCount, 1);
      expect(job.canStart, isTrue);
      expect(job.canComplete, isFalse);
    });

    test('a paid job whose point is missing has no exact point; nothing becomes 0,0', () async {
      final json = _job(status: 'CONFIRMED', paid: true);
      (json['location'] as Map<String, dynamic>)
        ..remove('latitude')
        ..remove('longitude');
      final api = _api((r) async => _json(200, json));
      final job = await api.workerJob('tok', 'b-1');
      expect(job.location.latitude, isNull);
      expect(job.location.longitude, isNull);
      expect(job.location.hasExactPoint, isFalse);
    });

    test('start and complete are POSTs on the worker\'s own booking and return the new state', () async {
      final seen = <http.Request>[];
      final api = _api((r) async {
        seen.add(r);
        return _json(200, _job(status: r.url.path.endsWith('/start') ? 'IN_PROGRESS' : 'COMPLETED', paid: true));
      });
      final started = await api.startWorkerJob('tok', 'b-1');
      final completed = await api.completeWorkerJob('tok', 'b-1');
      expect(seen.map((r) => '${r.method} ${r.url.path}'), [
        'POST /api/v1/workers/me/bookings/b-1/start',
        'POST /api/v1/workers/me/bookings/b-1/complete',
      ]);
      expect(started.status, 'IN_PROGRESS');
      expect(started.canComplete, isTrue);
      expect(completed.status, 'COMPLETED');
    });

    test('another worker\'s booking is a 404, not an empty job', () async {
      final api = _api((r) async => _json(404, {'statusCode': 404, 'code': 'NOT_FOUND', 'message': 'Booking not found'}));
      await expectLater(api.workerJob('tok', 'someone-elses'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
      await expectLater(api.startWorkerJob('tok', 'someone-elses'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });

    test('a worker session cannot be used without a token: the calls always send one', () async {
      var withAuth = 0;
      final api = _api((r) async {
        if (r.headers['Authorization'] == 'Bearer tok') withAuth++;
        return _json(200, _page([]));
      });
      await api.workerRequests('tok');
      await api.workerJobs('tok');
      await api.workerQuotes('tok');
      expect(withAuth, 3);
    });
  });
}
