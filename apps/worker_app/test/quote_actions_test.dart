import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/quotes/screens/send_quote_screen.dart';
import 'package:worker_app/features/requests/screens/request_detail_screen.dart';

import 'support/worker_harness.dart';

/// A worker who has quoted can change the quote or take it back from the request, through the real backend calls.
WorkerQuote _liveQuote() => WorkerQuote(
  id: 'quote-9',
  bookingId: 'req-1',
  bookingReference: 'HS-1',
  status: 'SUBMITTED',
  version: 1,
  money: money(price: 25000),
  proposedStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
  proposedEndAt: DateTime.now().toUtc().add(const Duration(days: 1, hours: 2)),
  validUntil: DateTime.now().toUtc().add(const Duration(hours: 20)),
  isExpired: false,
  message: 'Can do it',
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

Future<TestHsClient> _open(
  WidgetTester tester, {
  WorkerQuote? quote,
  int photos = 0,
}) async {
  phoneSize(tester, height: 1100);
  final kit = workerKit();
  await signInWorker(kit);
  final q = quote ?? _liveQuote();
  kit.api.workerQuoteList.add(q);
  kit.api.workerRequestList.add(request(id: 'req-1', quote: q, photos: photos));
  final services = makeJobsServices(kit);
  addTearDown(() {
    services.jobs.dispose();
    services.quotes.dispose();
    kit.client.auth.dispose();
  });
  await tester.pumpWidget(
    workerHarness(
      kit: kit,
      services: services,
      state: AppState(),
      home: RequestDetailScreen(
        request: request(id: 'req-1', quote: q, photos: photos),
      ),
    ),
  );
  await _settle(tester);
  return kit;
}

void main() {
  if (kDemoData) return;
  setUpAll(loadWorkerFonts);

  testWidgets('a live quote offers Edit and Withdraw', (tester) async {
    await _open(tester);
    expect(find.byKey(const Key('quote-card')), findsOneWidget);
    expect(find.byKey(const Key('quote-edit')), findsOneWidget);
    expect(find.byKey(const Key('quote-withdraw')), findsOneWidget);
    expect(find.byKey(const Key('request-send-quote')), findsNothing);
  });

  testWidgets('Edit opens the form with the quote, and saving changes it', (
    tester,
  ) async {
    final kit = await _open(tester);
    await tester.tap(find.byKey(const Key('quote-edit')));
    await _settle(tester);
    expect(find.byType(SendQuoteScreen), findsOneWidget);
    final price = tester.widget<EditableText>(
      find.descendant(
        of: find.byKey(const Key('quote-price')),
        matching: find.byType(EditableText),
      ),
    );
    expect(price.controller.text, '250');

    await tester.enterText(find.byKey(const Key('quote-price')), '300');
    await tester.pump();
    await tester.tap(find.byKey(const Key('quote-send')));
    await _settle(tester);

    final (id, sent) = kit.api.revisedQuotes.single;
    expect(id, 'quote-9');
    expect(sent.priceHalalas, 30000);
    expect(
      kit.api.submittedQuotes,
      isEmpty,
      reason: 'a change is not a new quote',
    );
    expect(kit.api.workerQuoteList.single.money.serviceHalalas, 30000);
    expect(find.byKey(const Key('quote-sent')), findsOneWidget);
  });

  testWidgets('Withdraw asks first, then takes the quote back', (tester) async {
    final kit = await _open(tester);
    await tester.tap(find.byKey(const Key('quote-withdraw')));
    await _settle(tester);
    expect(find.text('Withdraw your quote?'), findsOneWidget);
    expect(kit.api.withdrawnQuotes, isEmpty);

    await tester.tap(find.text('Keep quote'));
    await _settle(tester);
    expect(kit.api.withdrawnQuotes, isEmpty);

    await tester.tap(find.byKey(const Key('quote-withdraw')));
    await _settle(tester);
    await tester.tap(find.text('Withdraw').last);
    await _settle(tester);
    expect(kit.api.withdrawnQuotes, ['quote-9']);
    expect(kit.api.workerQuoteList.single.status, 'WITHDRAWN');
    expect(find.text('Quote withdrawn'), findsOneWidget);
    expect(find.byKey(const Key('quote-withdraw')), findsNothing);
  });

  testWidgets('a refused withdrawal says so and keeps the quote', (
    tester,
  ) async {
    final kit = await _open(tester);
    kit.api.quoteChangeResult = const ApiException(
      status: 409,
      code: 'QUOTE_NOT_LIVE',
      message: 'no',
    );
    await tester.tap(find.byKey(const Key('quote-withdraw')));
    await _settle(tester);
    await tester.tap(find.text('Withdraw').last);
    await _settle(tester);
    expect(kit.api.workerQuoteList.single.status, 'SUBMITTED');
    expect(find.byKey(const Key('quote-withdraw')), findsOneWidget);
  });

  testWidgets('a quote that is no longer live has no actions', (tester) async {
    final done = WorkerQuote(
      id: 'quote-9',
      bookingId: 'req-1',
      bookingReference: 'HS-1',
      status: 'REJECTED',
      version: 1,
      money: money(),
      proposedStartAt: null,
      proposedEndAt: null,
      validUntil: null,
      isExpired: false,
    );
    await _open(tester, quote: done);
    expect(find.byKey(const Key('quote-card')), findsOneWidget);
    expect(find.byKey(const Key('quote-edit')), findsNothing);
    expect(find.byKey(const Key('quote-withdraw')), findsNothing);
  });

  testWidgets(
    'the photos the customer attached show as a strip, each fetched through a signed link',
    (tester) async {
      final kit = await _open(tester, photos: 2);
      expect(find.byKey(const Key('photo-strip')), findsOneWidget);
      expect(find.byKey(const Key('photo-0')), findsOneWidget);
      expect(find.byKey(const Key('photo-1')), findsOneWidget);
      expect(kit.api.photoUrlRequests, [
        ('req-1', 'photo-0'),
        ('req-1', 'photo-1'),
      ]);
    },
  );

  testWidgets('no photos, no strip', (tester) async {
    await _open(tester);
    expect(find.byKey(const Key('photo-strip')), findsNothing);
  });

  testWidgets(
    'a photo whose link cannot be had says so instead of breaking the screen',
    (tester) async {
      phoneSize(tester, height: 1100);
      final kit = workerKit();
      await signInWorker(kit);
      kit.api.photoUrlsResult = const ApiException(
        status: 404,
        code: 'NOT_FOUND',
      );
      final q = _liveQuote();
      kit.api.workerRequestList.add(request(id: 'req-1', quote: q, photos: 1));
      final services = makeJobsServices(kit);
      addTearDown(() {
        services.jobs.dispose();
        services.quotes.dispose();
        kit.client.auth.dispose();
      });
      await tester.pumpWidget(
        workerHarness(
          kit: kit,
          services: services,
          state: AppState(),
          home: RequestDetailScreen(
            request: request(id: 'req-1', quote: q, photos: 1),
          ),
        ),
      );
      await _settle(tester);
      expect(find.text('Could not load'), findsOneWidget);
    },
  );

  testWidgets('what the customer asked to change is shown above the quote', (
    tester,
  ) async {
    final q = WorkerQuote(
      id: 'quote-9',
      bookingId: 'req-1',
      bookingReference: 'HS-1',
      status: 'SUBMITTED',
      version: 1,
      money: money(price: 25000),
      proposedStartAt: null,
      proposedEndAt: null,
      validUntil: DateTime.now().toUtc().add(const Duration(hours: 20)),
      isExpired: false,
      changeRequest: 'Please lower the price',
    );
    await _open(tester, quote: q);
    expect(find.byKey(const Key('quote-change-request')), findsOneWidget);
    expect(find.text('Please lower the price'), findsOneWidget);
  });
}
