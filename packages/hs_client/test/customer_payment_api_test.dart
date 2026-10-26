import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h) =>
    HsApi(baseUrl: 'https://api.example.com/api/v1', client: MockClient(h), clock: () => DateTime.utc(2026, 11, 1));
http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _money() => {'currency': 'SAR', 'serviceHalalas': 25000, 'vatHalalas': 3750, 'totalHalalas': 28750, 'vatRateBps': 1500};

Map<String, dynamic> _quote({int version = 2}) => {
  'id': 'q-1',
  'bookingId': 'b-1',
  'status': 'SUBMITTED',
  'version': version,
  'money': _money(),
  'proposedStartAt': '2026-11-03T15:00:00.000Z',
  'proposedEndAt': '2026-11-03T17:00:00.000Z',
  'estimatedDurationMinutes': 90,
  'message': 'Parts included',
  'validUntil': '2026-11-02T10:00:00.000Z',
  'isExpired': false,
  'worker': {
    'workerId': 'w-1',
    'fullName': 'Faisal',
    'fullNameAr': 'فيصل',
    'bio': null,
    'yearsOfExperience': 8,
    'serviceYearsOfExperience': 5,
    'ratingAverage': null,
    'ratingCount': 0,
  },
  'createdAt': '2026-11-01T09:00:00.000Z',
};

Map<String, dynamic> _detail({String status = 'OPEN', bool paid = false}) => {
  'id': 'b-1',
  'reference': 'HS-1',
  'status': status,
  'service': {'id': 's', 'slug': 'ac', 'nameEn': 'AC repair', 'nameAr': 'إصلاح المكيفات'},
  'cityId': 'c',
  'isUrgent': false,
  'preferredStartAt': '2026-11-03T15:00:00.000Z',
  'preferredEndAt': '2026-11-03T17:00:00.000Z',
  'expiresAt': '2026-11-03T10:00:00.000Z',
  'quoteCount': 1,
  'money': status == 'OPEN' ? null : _money(),
  'problemDescription': 'Weak cooling',
  'location': {
    'cityId': 'c',
    'cityNameEn': 'Riyadh',
    'cityNameAr': 'الرياض',
    'district': 'Al Olaya',
    'addressLine': 'King Fahd Rd',
    'latitude': 24.7136,
    'longitude': 46.6753,
  },
  'worker': status == 'OPEN' ? null : {'workerId': 'w-1', 'fullName': 'Faisal', 'fullNameAr': 'فيصل', if (paid) 'phone': '+966500000001'},
  'acceptedQuoteId': status == 'OPEN' ? null : 'q-1',
  'paymentDueAt': status == 'PAYMENT_PENDING' ? '2026-11-01T12:00:00.000Z' : null,
};

void main() {
  test('GET quotes: path, token and the parsed quote with the worker\'s public summary', () async {
    late http.Request seen;
    final api = _api((r) async {
      seen = r;
      return _json(200, {
        'items': [_quote()],
        'meta': {'page': 1, 'limit': 50, 'total': 1, 'totalPages': 1},
      });
    });
    final quotes = await api.bookingQuotes('tok', 'b-1');

    expect(seen.url.path, '/api/v1/bookings/b-1/quotes');
    expect(seen.headers['Authorization'], 'Bearer tok');
    final q = quotes.single;
    expect(q.money.serviceHalalas, 25000);
    expect(q.money.total, 287.5);
    expect(q.version, 2);
    expect(q.canAccept, isTrue);
    expect(q.worker.name(arabic: false), 'Faisal');
    expect(q.worker.name(arabic: true), 'فيصل');
    expect(q.worker.ratingAverage, isNull, reason: 'ratings do not exist yet; none is invented');
    expect(q.estimatedDurationMinutes, 90);
  });

  test('accepting sends only the version the customer saw, never a price', () async {
    late http.Request seen;
    final api = _api((r) async {
      seen = r;
      return _json(200, _detail(status: 'PAYMENT_PENDING'));
    });
    final detail = await api.acceptQuote('tok', 'b-1', 'q-1', expectedVersion: 2);

    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/v1/bookings/b-1/quotes/q-1/accept');
    expect(jsonDecode(seen.body), {'expectedVersion': 2});
    expect(detail.status, 'PAYMENT_PENDING');
    expect(detail.money!.totalHalalas, 28750);
    expect(detail.worker!.name(arabic: false), 'Faisal');
    expect(detail.worker!.phone, isNull, reason: 'the worker\'s phone is shared only once paid');
    expect(detail.paymentDueAt, DateTime.utc(2026, 11, 1, 12));
  });

  test('a quote the worker changed meanwhile is a 409 QUOTE_CHANGED', () async {
    final api = _api((r) async => _json(409, {'statusCode': 409, 'code': 'QUOTE_CHANGED', 'message': 'The quote changed'}));
    await expectLater(
      api.acceptQuote('tok', 'b-1', 'q-1', expectedVersion: 1),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'QUOTE_CHANGED')),
    );
  });

  test('the detail carries the own address and, once paid, the worker\'s phone', () async {
    final api = _api((r) async => _json(200, _detail(status: 'CONFIRMED', paid: true)));
    final d = await api.bookingDetail('tok', 'b-1');
    expect(d.location.hasExactPoint, isTrue);
    expect(d.worker!.phone, '+966500000001');
    expect(d.serviceName(arabic: true), 'إصلاح المكيفات');
  });

  test('starting payment sends the Idempotency-Key header and no amount', () async {
    late http.Request seen;
    final api = _api((r) async {
      seen = r;
      return _json(201, {
        'id': 'p-1',
        'bookingId': 'b-1',
        'attemptNumber': 1,
        'status': 'PROCESSING',
        'amountHalalas': 28750,
        'currency': 'SAR',
        'simulated': true,
        'checkout': {'url': 'https://mock-checkout.invalid/pay/abc', 'expiresAt': '2026-11-01T12:30:00.000Z'},
        'failure': null,
        'createdAt': '2026-11-01T10:00:00.000Z',
      });
    });
    final p = await api.startPayment('tok', 'b-1', idempotencyKey: 'key-12345678');

    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/v1/bookings/b-1/payments');
    expect(seen.headers['Idempotency-Key'], 'key-12345678');
    expect(seen.headers['Authorization'], 'Bearer tok');
    expect(jsonDecode(seen.body), isEmpty, reason: 'the amount is the server\'s agreed total; the client cannot send one');
    expect(p.simulated, isTrue);
    expect(p.isOpen, isTrue);
    expect(p.amountHalalas, 28750);
    expect(p.checkoutUrl, 'https://mock-checkout.invalid/pay/abc');
  });

  test('no payment provider configured is a 503 with its code', () async {
    final api = _api(
      (r) async => _json(503, {'statusCode': 503, 'code': 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'message': 'Online payment is temporarily unavailable'}),
    );
    await expectLater(
      api.startPayment('tok', 'b-1', idempotencyKey: 'key-12345678'),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 503).having((e) => e.code, 'code', 'PAYMENT_PROVIDER_NOT_CONFIGURED')),
    );
  });

  test('a failed attempt carries the failure and is not open', () {
    final p = PaymentAttempt.fromJson({
      'id': 'p-1',
      'bookingId': 'b-1',
      'status': 'FAILED',
      'amountHalalas': 28750,
      'currency': 'SAR',
      'simulated': false,
      'checkout': null,
      'failure': {'code': 'CARD_DECLINED', 'message': 'Declined'},
    });
    expect(p.isOpen, isFalse);
    expect(p.failureCode, 'CARD_DECLINED');
    expect(p.checkoutUrl, isNull);
  });

  test('paying in cash is a POST with no body fields and returns the confirmed booking with its method', () async {
    late http.Request seen;
    final api = _api((r) async {
      seen = r;
      return _json(200, {..._detail(status: 'CONFIRMED', paid: true), 'paymentMethod': 'CASH'});
    });
    final d = await api.payCash('tok', 'b-1');

    expect(seen.method, 'POST');
    expect(seen.url.path, '/api/v1/bookings/b-1/payments/cash');
    expect(seen.headers['Authorization'], 'Bearer tok');
    expect(jsonDecode(seen.body), isEmpty, reason: 'no amount: the total is the agreed price is the servers');
    expect(d.status, 'CONFIRMED');
    expect(d.isCash, isTrue);
    expect(d.worker!.phone, '+966500000001');
  });

  test('the worker sees the method and when the cash was collected', () async {
    final seen = <http.Request>[];
    final api = _api((r) async {
      seen.add(r);
      return _json(200, {
        'id': 'b-1',
        'reference': 'HS-1',
        'status': 'IN_PROGRESS',
        'service': {'id': 's', 'nameEn': 'AC', 'nameAr': 'x'},
        'location': {'cityId': 'c', 'cityNameEn': 'Riyadh', 'cityNameAr': 'x'},
        'isUrgent': false,
        'paymentMethod': 'CASH',
        'cashCollectedAt': r.url.path.endsWith('cash-collected') ? '2026-11-03T16:00:00.000Z' : null,
      });
    });
    final before = await api.workerJob('tok', 'b-1');
    expect(before.isCash, isTrue);
    expect(before.canConfirmCash, isTrue);
    final after = await api.confirmCashCollected('tok', 'b-1');
    expect(seen.last.method, 'POST');
    expect(seen.last.url.path, '/api/v1/workers/me/bookings/b-1/cash-collected');
    expect(after.cashCollectedAt, DateTime.utc(2026, 11, 3, 16));
    expect(after.canConfirmCash, isFalse);
  });
}
