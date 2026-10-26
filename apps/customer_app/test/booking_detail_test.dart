import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/features/bookings/logic/booking_detail_controller.dart';
import 'package:customer_app/features/bookings/screens/booking_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

import 'support/booking_harness.dart';

/// Choosing a worker's quote and paying, through the real controller and screen, on the shared fake backend. Nothing here marks a booking
/// paid by itself: only the server's status does.
const _money = CustomerMoney(
  currency: 'SAR',
  serviceHalalas: 25000,
  vatHalalas: 3750,
  totalHalalas: 28750,
  vatRateBps: 1500,
);

BookingDetail _open() => BookingDetail(
  id: 'b-1',
  reference: 'HS-1',
  status: 'OPEN',
  serviceNameEn: 'AC repair',
  serviceNameAr: 'إصلاح المكيفات',
  location: const BookingLocation(
    cityId: 'c',
    cityNameEn: 'Riyadh',
    cityNameAr: 'الرياض',
    district: 'Al Olaya',
    addressLine: 'King Fahd Rd',
    latitude: 24.7136,
    longitude: 46.6753,
  ),
  isUrgent: false,
  problemDescription: 'Weak cooling and dripping water',
  preferredStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
  preferredEndAt: DateTime.now().toUtc().add(const Duration(days: 1, hours: 2)),
  expiresAt: DateTime.now().toUtc().add(const Duration(days: 2)),
);

CustomerQuote _quote({
  String id = 'q-1',
  int version = 1,
  String name = 'Faisal',
  CustomerMoney money = _money,
}) => CustomerQuote(
  id: id,
  bookingId: 'b-1',
  status: 'SUBMITTED',
  version: version,
  money: money,
  worker: QuoteWorker(
    workerId: 'w-$id',
    fullName: name,
    fullNameAr: 'فيصل',
    yearsOfExperience: 8,
    serviceYearsOfExperience: 5,
  ),
  isExpired: false,
  proposedStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
  proposedEndAt: DateTime.now().toUtc().add(const Duration(days: 1, hours: 2)),
  message: 'Parts included',
  validUntil: DateTime.now().toUtc().add(const Duration(hours: 20)),
);

ApiException _api(int status, String code) =>
    ApiException(status: status, code: code, message: code);

class _Rig {
  _Rig(this.kit, this.c);
  final TestHsClient kit;
  final BookingDetailController c;
  FakeApi get api => kit.api;
}

Future<_Rig> _rig({bool withQuote = true}) async {
  final kit = TestHsClient();
  await signIn(kit);
  kit.api.detailStore['b-1'] = _open();
  if (withQuote) kit.api.customerQuoteList.add(_quote());
  final c = BookingDetailController(
    api: kit.api,
    auth: kit.client.auth,
    bookingId: 'b-1',
  );
  addTearDown(() {
    c.dispose();
    kit.client.auth.dispose();
  });
  return _Rig(kit, c);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  group('controller', () {
    test('an open booking loads with its live quotes', () async {
      final r = await _rig();
      await r.c.load();
      expect(r.c.status, DetailStatus.ready);
      expect(r.c.detail!.status, 'OPEN');
      expect(r.c.quotes.single.money.totalHalalas, 28750);
    });

    test(
      'someone else\'s or a missing booking is "gone", not an empty page',
      () async {
        final r = await _rig();
        final other = BookingDetailController(
          api: r.api,
          auth: r.kit.client.auth,
          bookingId: 'someone-elses',
        );
        addTearDown(other.dispose);
        await other.load();
        expect(other.status, DetailStatus.gone);
        expect(other.detail, isNull);
      },
    );

    test(
      'a load that fails is "failed"; later failures keep what was shown',
      () async {
        final r = await _rig();
        r.api.bookingDetailResult = _api(0, 'NETWORK');
        await r.c.load();
        expect(r.c.status, DetailStatus.failed);
        r.api.bookingDetailResult = null;
        await r.c.load();
        expect(r.c.status, DetailStatus.ready);
        r.api.bookingDetailResult = _api(503, 'UNAVAILABLE');
        await r.c.load();
        expect(r.c.status, DetailStatus.ready);
        expect(r.c.detail, isNotNull);
      },
    );

    test(
      'choosing a quote sends the quote id and the version seen, and the booking becomes PAYMENT_PENDING with the server\'s total',
      () async {
        final r = await _rig();
        await r.c.load();
        expect(await r.c.accept(r.c.quotes.single), isTrue);

        expect(r.api.acceptedQuotes.single, ('b-1', 'q-1', 1));
        expect(r.c.detail!.status, 'PAYMENT_PENDING');
        expect(r.c.detail!.money!.totalHalalas, 28750);
        expect(r.c.detail!.worker!.name(arabic: false), 'Faisal');
        expect(r.c.isPaid, isFalse);
        expect(r.c.quotes, isEmpty);
      },
    );

    test('taps while choosing share one request', () async {
      final r = await _rig();
      await r.c.load();
      final q = r.c.quotes.single;
      final results = await Future.wait([
        r.c.accept(q),
        r.c.accept(q),
        r.c.accept(q),
      ]);
      expect(results, everyElement(isTrue));
      expect(r.api.acceptedQuotes, hasLength(1));
    });

    test(
      'a quote the worker changed meanwhile is refused, and the new price is loaded',
      () async {
        final r = await _rig();
        await r.c.load();
        final seen = r.c.quotes.single;
        r.api.customerQuoteList[0] = _quote(
          version: 2,
          money: const CustomerMoney(
            currency: 'SAR',
            serviceHalalas: 40000,
            vatHalalas: 6000,
            totalHalalas: 46000,
            vatRateBps: 1500,
          ),
        );

        expect(await r.c.accept(seen), isFalse);
        expect(r.c.failure!.problem, ActionProblem.quoteChanged);
        await Future<void>.delayed(Duration.zero);
        await r.c.load();
        expect(r.c.quotes.single.version, 2);
        expect(
          r.c.quotes.single.money.totalHalalas,
          46000,
          reason: 'the customer sees the new price before agreeing',
        );
        expect(r.c.detail!.status, 'OPEN');
      },
    );

    test(
      'paying starts one attempt with an idempotency key and does NOT mark the booking paid',
      () async {
        final r = await _rig();
        await r.c.load();
        await r.c.accept(r.c.quotes.single);

        final attempt = await r.c.pay();

        expect(attempt, isNotNull);
        expect(attempt!.simulated, isTrue);
        expect(attempt.isOpen, isTrue);
        final (bookingId, key) = r.api.startedPayments.single;
        expect(bookingId, 'b-1');
        expect(key.length, inInclusiveRange(8, 128));
        expect(
          r.c.isPaid,
          isFalse,
          reason: 'only the server\'s CONFIRMED status means paid',
        );
        expect(r.c.detail!.status, 'PAYMENT_PENDING');
      },
    );

    test(
      'taps while paying share one request; a retry after a lost answer reuses the key (so it is the same payment)',
      () async {
        final r = await _rig();
        await r.c.load();
        await r.c.accept(r.c.quotes.single);

        await Future.wait([r.c.pay(), r.c.pay(), r.c.pay()]);
        expect(r.api.startedPayments, hasLength(1));

        final r2 = await _rig();
        await r2.c.load();
        await r2.c.accept(r2.c.quotes.single);
        r2.api.startPaymentResult = _api(0, 'NETWORK');
        expect(await r2.c.pay(), isNull);
        expect(r2.c.failure!.problem, ActionProblem.network);
        r2.api.startPaymentResult = null;
        final again = await r2.c.pay();
        expect(again, isNotNull);
        expect(
          r2.api.startedPayments.map((e) => e.$2).toSet(),
          hasLength(1),
          reason: 'same Idempotency-Key on the retry',
        );
      },
    );

    test(
      'a definite refusal ends the attempt: the next try uses a new key',
      () async {
        final r = await _rig();
        await r.c.load();
        await r.c.accept(r.c.quotes.single);
        r.api.startPaymentResult = _api(409, 'PAYMENT_DEADLINE_PASSED');
        await r.c.pay();
        expect(r.c.failure!.problem, ActionProblem.deadlinePassed);
        r.api.startPaymentResult = null;
        await r.c.pay();
        expect(r.api.startedPayments.map((e) => e.$2).toSet(), hasLength(2));
      },
    );

    test(
      'no payment provider configured is said plainly and nothing is marked paid',
      () async {
        final r = await _rig();
        await r.c.load();
        await r.c.accept(r.c.quotes.single);
        r.api.startPaymentResult = _api(503, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
        expect(await r.c.pay(), isNull);
        expect(r.c.failure!.problem, ActionProblem.paymentsNotConfigured);
        expect(r.c.isPaid, isFalse);
      },
    );

    test(
      'paid only when the server says CONFIRMED (the worker\'s phone is released then)',
      () async {
        final r = await _rig();
        await r.c.load();
        await r.c.accept(r.c.quotes.single);
        await r.c.pay();
        await r.c.refreshPayment();
        expect(
          r.c.isPaid,
          isFalse,
          reason: 'the server still says PAYMENT_PENDING',
        );

        // the server receives its verified provider event
        final d = r.api.detailStore['b-1']!;
        r.api.detailStore['b-1'] = BookingDetail(
          id: d.id,
          reference: d.reference,
          status: 'CONFIRMED',
          serviceNameEn: d.serviceNameEn,
          serviceNameAr: d.serviceNameAr,
          location: d.location,
          isUrgent: d.isUrgent,
          problemDescription: d.problemDescription,
          money: d.money,
          worker: AssignedWorker(
            workerId: d.worker!.workerId,
            fullName: d.worker!.fullName,
            phone: '+966500000001',
          ),
          acceptedQuoteId: d.acceptedQuoteId,
        );
        await r.c.refreshPayment();
        expect(r.c.isPaid, isTrue);
        expect(r.c.detail!.worker!.phone, '+966500000001');
      },
    );

    test('a booking that is no longer open cannot take a quote', () async {
      final r = await _rig();
      await r.c.load();
      final q = r.c.quotes.single;
      await r.c.accept(q); // now PAYMENT_PENDING
      r.c.clearFailure();
      expect(await r.c.accept(q), isFalse);
      expect(r.c.failure!.problem, ActionProblem.notAvailable);
    });

    test(
      'paying in cash confirms the booking with the server\'s answer: no payment attempt, the worker\'s phone released',
      () async {
        final r = await _rig();
        await r.c.load();
        await r.c.accept(r.c.quotes.single);

        expect(await r.c.payCash(), isTrue);

        expect(r.api.cashChosen, ['b-1']);
        expect(r.c.detail!.status, 'CONFIRMED');
        expect(r.c.detail!.isCash, isTrue);
        expect(r.c.isPaid, isTrue);
        expect(r.c.detail!.worker!.phone, isNotNull);
        expect(
          r.api.startedPayments,
          isEmpty,
          reason: 'no online payment is started for cash',
        );
      },
    );

    test('taps while choosing cash share one request', () async {
      final r = await _rig();
      await r.c.load();
      await r.c.accept(r.c.quotes.single);
      final results = await Future.wait([
        r.c.payCash(),
        r.c.payCash(),
        r.c.payCash(),
      ]);
      expect(results, everyElement(isTrue));
      expect(r.api.cashChosen, hasLength(1));
    });

    test('cash is not marked paid when the server refuses', () async {
      final r = await _rig();
      await r.c.load();
      await r.c.accept(r.c.quotes.single);
      r.api.cashResult = _api(409, 'PAYMENT_DEADLINE_PASSED');
      expect(await r.c.payCash(), isFalse);
      expect(r.c.failure!.problem, ActionProblem.deadlinePassed);
      expect(r.c.isPaid, isFalse);
      r.api.cashResult = _api(0, 'NETWORK');
      expect(await r.c.payCash(), isFalse);
      expect(r.c.failure!.problem, ActionProblem.network);
      expect(r.c.detail!.status, 'PAYMENT_PENDING');
    });
  });

  if (kDemoData) return;

  group('screen', () {
    setUpAll(loadAppFonts);

    BookingDetail pending() => BookingDetail(
      id: 'b-1',
      reference: 'HS-1',
      status: 'PAYMENT_PENDING',
      serviceNameEn: 'AC repair',
      serviceNameAr: 'إصلاح',
      location: const BookingLocation(cityId: 'c'),
      isUrgent: false,
      problemDescription: 'x',
      money: _money,
      worker: const AssignedWorker(workerId: 'w', fullName: 'Faisal'),
      acceptedQuoteId: 'q-1',
      paymentDueAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
    );

    Future<_Rig> open(
      WidgetTester tester, {
      bool withQuote = true,
      bool arabic = false,
      void Function(FakeApi)? arrange,
    }) async {
      phoneSize(tester, height: 1500);
      final kit = TestHsClient();
      await signIn(kit);
      kit.api.detailStore['b-1'] = _open();
      if (withQuote) kit.api.customerQuoteList.add(_quote());
      arrange?.call(kit.api);
      final services = makeServices(kit);
      addTearDown(() {
        services.catalog.dispose();
        services.submitter.dispose();
        services.bookings.dispose();
        kit.client.auth.dispose();
      });
      await tester.pumpWidget(
        harness(
          kit: kit,
          services: services,
          state: AppState()..setArabic(arabic),
          arabic: arabic,
          home: const BookingDetailScreen(bookingId: 'b-1'),
        ),
      );
      await _settle(tester);
      return _Rig(
        kit,
        BookingDetailController(
          api: kit.api,
          auth: kit.client.auth,
          bookingId: 'b-1',
        ),
      );
    }

    testWidgets(
      'quote -> choose (with a confirmation) -> the payment methods',
      (tester) async {
        final r = await open(tester);
        expect(find.text('Faisal'), findsOneWidget);
        expect(find.text('SAR 250'), findsOneWidget);
        expect(find.text('SAR 287.50'), findsOneWidget);
        expect(find.textContaining('5 years'), findsOneWidget);

        await tester.tap(find.byKey(const Key('accept-q-1')));
        await _settle(tester);
        expect(find.byKey(const Key('confirm-dialog')), findsOneWidget);
        expect(
          r.api.acceptedQuotes,
          isEmpty,
          reason: 'nothing is chosen until the customer confirms',
        );
        await tester.tap(find.byKey(const Key('confirm-accept')));
        await _settle(tester);

        expect(r.api.acceptedQuotes.single, ('b-1', 'q-1', 1));
        expect(find.byKey(const Key('agreed')), findsOneWidget);
        expect(find.byKey(const Key('pay-cash')), findsOneWidget);
      },
    );

    testWidgets(
      'cash is the available method; card, Apple Pay and STC Pay are shown as "Coming soon" and do nothing',
      (tester) async {
        final r = await open(
          tester,
          arrange: (api) => api.detailStore['b-1'] = pending(),
        );

        expect(find.byKey(const Key('method-cash')), findsOneWidget);
        expect(find.text('Cash'), findsOneWidget);
        expect(find.byKey(const Key('coming-soon')), findsNWidgets(3));
        expect(find.text('Coming soon'), findsNWidgets(3));
        expect(find.text('Apple Pay'), findsOneWidget);
        expect(find.text('STC Pay'), findsOneWidget);
        expect(find.textContaining('mada'), findsOneWidget);

        for (final key in [
          'method-bdCard',
          'method-bdApplePay',
          'method-bdStcPay',
        ]) {
          await tester.tap(find.byKey(Key(key)), warnIfMissed: false);
          await _settle(tester);
        }
        expect(
          r.api.startedPayments,
          isEmpty,
          reason: 'no online payment can be started',
        );
        expect(r.api.cashChosen, isEmpty);
        expect(find.byKey(const Key('pay-now')), findsNothing);
      },
    );

    testWidgets(
      'paying in cash asks first, then confirms the booking from the server\'s answer',
      (tester) async {
        final r = await open(
          tester,
          arrange: (api) => api.detailStore['b-1'] = pending(),
        );

        await tester.tap(find.byKey(const Key('pay-cash')));
        await _settle(tester);
        expect(find.byKey(const Key('cash-dialog')), findsOneWidget);
        expect(find.textContaining('SAR 287.50'), findsWidgets);
        expect(
          r.api.cashChosen,
          isEmpty,
          reason: 'nothing happens until the customer confirms',
        );

        await tester.tap(find.byKey(const Key('confirm-cash')));
        await _settle(tester);

        expect(r.api.cashChosen, ['b-1']);
        expect(find.byKey(const Key('paid')), findsOneWidget);
        expect(find.byKey(const Key('cash-due')), findsOneWidget);
        expect(
          find.text('Pay SAR 287.50 in cash to the professional.'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('worker-phone')), findsOneWidget);
        expect(find.byKey(const Key('pay-cash')), findsNothing);
      },
    );

    testWidgets('declining the cash confirmation pays nothing', (tester) async {
      final r = await open(
        tester,
        arrange: (api) => api.detailStore['b-1'] = pending(),
      );
      await tester.tap(find.byKey(const Key('pay-cash')));
      await _settle(tester);
      await tester.tap(find.text('Not now'));
      await _settle(tester);
      expect(r.api.cashChosen, isEmpty);
      expect(find.byKey(const Key('paid')), findsNothing);
    });

    testWidgets(
      'a refused cash payment is explained and nothing is marked paid',
      (tester) async {
        await open(
          tester,
          arrange: (api) {
            api.detailStore['b-1'] = pending();
            api.cashResult = _api(409, 'PAYMENT_DEADLINE_PASSED');
          },
        );
        await tester.tap(find.byKey(const Key('pay-cash')));
        await _settle(tester);
        await tester.tap(find.byKey(const Key('confirm-cash')));
        await _settle(tester);
        expect(find.text('The time to pay has passed.'), findsOneWidget);
        expect(find.byKey(const Key('paid')), findsNothing);
      },
    );

    testWidgets('declining the quote confirmation chooses nothing', (
      tester,
    ) async {
      final r = await open(tester);
      await tester.tap(find.byKey(const Key('accept-q-1')));
      await _settle(tester);
      await tester.tap(find.text('Not now'));
      await _settle(tester);
      expect(r.api.acceptedQuotes, isEmpty);
    });

    testWidgets('no quotes yet is stated', (tester) async {
      await open(tester, withQuote: false);
      expect(find.byKey(const Key('no-quotes')), findsOneWidget);
    });

    testWidgets('a changed quote is explained and the new price is shown', (
      tester,
    ) async {
      final r = await open(tester);
      r.api.customerQuoteList[0] = _quote(
        version: 2,
        money: const CustomerMoney(
          currency: 'SAR',
          serviceHalalas: 40000,
          vatHalalas: 6000,
          totalHalalas: 46000,
          vatRateBps: 1500,
        ),
      );
      await tester.tap(find.byKey(const Key('accept-q-1')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('confirm-accept')));
      await _settle(tester);
      expect(find.byKey(const Key('detail-error')), findsOneWidget);
      expect(find.textContaining('changed this quote'), findsOneWidget);
      expect(find.text('SAR 460'), findsOneWidget);
    });

    testWidgets(
      'a booking already paid shows the confirmation and no payment choices',
      (tester) async {
        await open(
          tester,
          arrange: (api) {
            api.detailStore['b-1'] = BookingDetail(
              id: 'b-1',
              reference: 'HS-1',
              status: 'CONFIRMED',
              serviceNameEn: 'AC repair',
              serviceNameAr: 'إصلاح',
              location: const BookingLocation(cityId: 'c'),
              isUrgent: false,
              problemDescription: 'x',
              money: _money,
              worker: const AssignedWorker(
                workerId: 'w',
                fullName: 'Faisal',
                phone: '+966500000001',
              ),
              acceptedQuoteId: 'q-1',
              paymentMethod: 'CASH',
            );
          },
        );
        expect(find.byKey(const Key('paid')), findsOneWidget);
        expect(find.byKey(const Key('worker-phone')), findsOneWidget);
        expect(find.byKey(const Key('cash-due')), findsOneWidget);
        expect(find.byKey(const Key('pay-cash')), findsNothing);
        expect(find.byKey(const Key('coming-soon')), findsNothing);
      },
    );

    testWidgets('unavailable booking, load failure with retry, and Arabic', (
      tester,
    ) async {
      await open(tester, arrange: (api) => api.detailStore.clear());
      expect(find.byKey(const Key('detail-gone')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());

      final r = await open(
        tester,
        arrange: (api) => api.bookingDetailResult = _api(0, 'NETWORK'),
      );
      expect(find.byKey(const Key('detail-failed')), findsOneWidget);
      r.api.bookingDetailResult = null;
      await tester.tap(find.byKey(const Key('detail-retry')));
      await _settle(tester);
      expect(find.text('Faisal'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());

      await open(
        tester,
        arabic: true,
        arrange: (api) => api.detailStore['b-1'] = pending(),
      );
      expect(find.text('قريباً'), findsNWidgets(3));
      expect(find.text('نقداً'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
