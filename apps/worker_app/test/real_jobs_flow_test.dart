import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/app/jobs_scope.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/dashboard/screens/main_shell.dart';
import 'package:worker_app/features/jobs/screens/active_job_screen.dart';
import 'package:worker_app/features/quotes/screens/send_quote_screen.dart';
import 'package:worker_app/features/requests/screens/request_detail_screen.dart';

import 'support/worker_harness.dart';

/// The worker's side of the booking path through the real screens, on the shared fake backend: requests -> detail -> quote -> the customer's
/// choice -> an assigned job -> start -> complete. Prototype fixtures are off (DEMO_DATA is not set), exactly as in a release build.
class _Ctx {
  _Ctx(this.kit, this.services, this.state);
  final TestHsClient kit;
  final JobsServices services;
  final AppState state;
  FakeApi get api => kit.api;
}

ApiException _api(
  int status,
  String code, {
  String? message,
  Map<String, dynamic>? details,
}) => ApiException(
  status: status,
  code: code,
  message: message,
  details: details,
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

Future<_Ctx> _boot(
  WidgetTester tester, {
  Widget? home,
  String? root,
  bool arabic = false,
  int tab = 0,
  int jobsTab = 0,
  void Function(FakeApi)? arrange,
}) async {
  phoneSize(tester, height: 1100);
  final kit = workerKit();
  await signInWorker(kit);
  arrange?.call(kit.api);
  final services = makeJobsServices(kit);
  final state = AppState()
    ..setArabic(arabic)
    ..tab = tab
    ..jobsTab = jobsTab;
  addTearDown(() {
    services.jobs.dispose();
    services.quotes.dispose();
    kit.client.auth.dispose();
  });
  await tester.pumpWidget(
    workerHarness(
      kit: kit,
      services: services,
      state: state,
      home: home ?? const MainShell(),
      arabic: arabic,
      rootRouteName: root,
    ),
  );
  await _settle(tester);
  return _Ctx(kit, services, state);
}

Future<void> _tapKey(WidgetTester tester, String key) async {
  await tester.tap(find.byKey(Key(key)));
  await _settle(tester);
}

Future<void> _tapText(WidgetTester tester, String text) async {
  await tester.tap(find.text(text).first);
  await _settle(tester);
}

bool _enabled(WidgetTester tester, String key) =>
    (tester.widget(find.byKey(Key(key))) as dynamic).enabled as bool;

void main() {
  if (kDemoData) {
    test(
      'these tests describe the release behaviour: run them without DEMO_DATA',
      () {},
      skip: 'DEMO_DATA is on',
    );
    return;
  }

  setUpAll(loadWorkerFonts);

  group('from an open request to a sent quote', () {
    testWidgets(
      'jobs tab -> request -> quote -> the quote the server priced -> Quoted tab',
      (tester) async {
        final ctx = await _boot(
          tester,
          root: '/home',
          tab: 1,
          arrange: (api) => api.workerRequestList.add(
            request(id: 'req-1', reference: 'HS-100', urgent: true, photos: 2),
          ),
        );

        // the list is the backend's, with the area only
        expect(find.text('AC repair'), findsOneWidget);
        expect(find.textContaining('Al Olaya'), findsWidgets);
        expect(find.text('Faisal Al-Harbi'), findsNothing);
        expect(find.text('AC Deep Cleaning'), findsNothing);
        await _tapText(tester, 'Review and quote');

        // the detail: description from the detail endpoint, the area only, and the note that the address comes after payment
        expect(find.byType(RequestDetailScreen), findsOneWidget);
        expect(ctx.api.calls, contains('workerRequest'));
        expect(find.byKey(const Key('request-description')), findsOneWidget);
        expect(find.textContaining('Two split units'), findsOneWidget);
        expect(find.byKey(const Key('area-only-note')), findsOneWidget);
        expect(find.byKey(const Key('request-photos')), findsOneWidget);
        expect(find.textContaining('King Fahd'), findsNothing);
        expect(find.byKey(const Key('request-send-quote')), findsOneWidget);

        await _tapKey(tester, 'request-send-quote');
        expect(find.byType(SendQuoteScreen), findsOneWidget);
        expect(_enabled(tester, 'quote-send'), isFalse, reason: 'no price yet');

        await tester.enterText(find.byKey(const Key('quote-price')), '250');
        await tester.pump();
        expect(_enabled(tester, 'quote-send'), isTrue);
        await _tapKey(tester, 'quote-send');

        // exactly one request, with the worker's own price in halalas
        final (id, sent) = ctx.api.submittedQuotes.single;
        expect(id, 'req-1');
        expect(sent.priceHalalas, 25000);
        expect(sent.proposedStartAt.isAfter(DateTime.now().toUtc()), isTrue);

        // the card is what the server answered
        expect(find.byKey(const Key('quote-sent')), findsOneWidget);
        expect(find.byKey(const Key('quote-card')), findsOneWidget);
        expect(
          find.text('SAR 212.50'),
          findsOneWidget,
          reason: 'payout = price - commission, worked out by the server',
        );
        expect(
          find.text('SAR 287.50'),
          findsOneWidget,
          reason: 'what the customer pays',
        );

        // and the request now lives under Quoted
        await _tapKey(tester, 'quote-back');
        expect(ctx.state.tab, 1);
        await _tapKey(tester, 'jobs-tab-1');
        expect(find.text('AC repair'), findsOneWidget);
        expect(find.text('Awaiting customer'), findsWidgets);
        await _tapKey(tester, 'jobs-tab-0');
        expect(find.byKey(const Key('jobs-empty-0')), findsOneWidget);
      },
    );

    testWidgets('a price that is not a number is flagged and cannot be sent', (
      tester,
    ) async {
      final ctx = await _boot(
        tester,
        home: SendQuoteScreen(request: request(id: 'req-1')),
        arrange: (api) => api.workerRequestList.add(request(id: 'req-1')),
      );
      for (final bad in ['abc', '0', '12.345']) {
        await tester.enterText(find.byKey(const Key('quote-price')), bad);
        await tester.pump();
        expect(_enabled(tester, 'quote-send'), isFalse, reason: bad);
      }
      expect(find.text('Enter a price above zero.'), findsOneWidget);
      expect(ctx.api.submittedQuotes, isEmpty);
    });

    testWidgets(
      'a price below the backend\'s minimum shows the minimum it asked for',
      (tester) async {
        final ctx = await _boot(
          tester,
          home: SendQuoteScreen(request: request(id: 'req-1')),
          arrange: (api) {
            api.workerRequestList.add(request(id: 'req-1'));
            api.submitQuoteResult = _api(
              400,
              'PRICE_BELOW_MINIMUM',
              details: {'minServiceChargeHalalas': 9900},
            );
          },
        );
        await tester.enterText(find.byKey(const Key('quote-price')), '50');
        await tester.pump();
        await _tapKey(tester, 'quote-send');
        expect(find.byKey(const Key('quote-error')), findsOneWidget);
        expect(find.textContaining('SAR 99'), findsOneWidget);
        expect(find.byKey(const Key('quote-sent')), findsNothing);
        expect(ctx.api.submittedQuotes, hasLength(1));
      },
    );

    testWidgets(
      'no connection: says nothing is sent twice, keeps the price, and the retry sends one quote',
      (tester) async {
        final ctx = await _boot(
          tester,
          home: SendQuoteScreen(request: request(id: 'req-1')),
          arrange: (api) {
            api.workerRequestList.add(request(id: 'req-1'));
            api.submitFailAfterCreating = _api(0, 'NETWORK');
          },
        );
        await tester.enterText(find.byKey(const Key('quote-price')), '250');
        await tester.pump();
        await _tapKey(tester, 'quote-send');
        expect(find.textContaining('No connection'), findsOneWidget);
        expect(find.byKey(const Key('quote-sent')), findsNothing);
        expect(ctx.api.workerQuoteList, hasLength(1));

        await _tapKey(tester, 'quote-send');
        expect(find.byKey(const Key('quote-sent')), findsOneWidget);
        expect(
          ctx.api.workerQuoteList,
          hasLength(1),
          reason: 'the retry adopted the existing quote',
        );
      },
    );

    testWidgets('tapping Send repeatedly makes one quote', (tester) async {
      final ctx = await _boot(
        tester,
        home: SendQuoteScreen(request: request(id: 'req-1')),
        arrange: (api) => api.workerRequestList.add(request(id: 'req-1')),
      );
      await tester.enterText(find.byKey(const Key('quote-price')), '250');
      await tester.pump();
      for (var i = 0; i < 3; i++) {
        await tester.tap(
          find.byKey(const Key('quote-send')),
          warnIfMissed: false,
        );
      }
      await _settle(tester);
      expect(ctx.api.submittedQuotes, hasLength(1));
      expect(ctx.api.workerQuoteList, hasLength(1));
    });

    testWidgets(
      'a request that has closed meanwhile is reported, not retried',
      (tester) async {
        await _boot(
          tester,
          home: SendQuoteScreen(request: request(id: 'req-1')),
          arrange: (api) {
            api.workerRequestList.add(request(id: 'req-1'));
            api.submitQuoteResult = _api(409, 'BOOKING_NOT_OPEN');
          },
        );
        await tester.enterText(find.byKey(const Key('quote-price')), '250');
        await tester.pump();
        await _tapKey(tester, 'quote-send');
        expect(
          find.text('This request is no longer taking quotes.'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a request that is gone (404) says so and offers no quote button',
      (tester) async {
        await _boot(
          tester,
          home: RequestDetailScreen(request: request(id: 'gone')),
        );
        expect(find.byKey(const Key('request-gone')), findsOneWidget);
        expect(find.byKey(const Key('request-send-quote')), findsNothing);
      },
    );

    testWidgets('a detail that cannot be loaded offers a retry', (
      tester,
    ) async {
      final ctx = await _boot(
        tester,
        home: RequestDetailScreen(request: request(id: 'req-1')),
        arrange: (api) {
          api.workerRequestList.add(request(id: 'req-1'));
          api.workerRequestResult = _api(0, 'NETWORK');
        },
      );
      expect(find.byKey(const Key('request-retry')), findsOneWidget);
      ctx.api.workerRequestResult = null;
      await _tapKey(tester, 'request-retry');
      expect(find.byKey(const Key('request-description')), findsOneWidget);
    });
  });

  group('the lists', () {
    testWidgets(
      'loading, empty, failed with retry, and a refresh that fails keeps the list',
      (tester) async {
        final ctx = await _boot(
          tester,
          tab: 1,
          arrange: (api) => api.workerRequestsResult = _api(0, 'NETWORK'),
        );
        expect(find.byKey(const Key('jobs-failed')), findsOneWidget);

        ctx.api.workerRequestsResult = null;
        await _tapKey(tester, 'jobs-retry');
        expect(find.byKey(const Key('jobs-empty-0')), findsOneWidget);
        expect(find.text('No new requests'), findsOneWidget);

        ctx.api.workerRequestList.add(request());
        await ctx.services.jobs.refresh();
        await _settle(tester);
        expect(find.text('AC repair'), findsOneWidget);

        ctx.api.workerRequestsResult = _api(503, 'UNAVAILABLE');
        await ctx.services.jobs.refresh();
        await _settle(tester);
        expect(find.byKey(const Key('jobs-refresh-failed')), findsOneWidget);
        expect(
          find.text('AC repair'),
          findsOneWidget,
          reason: 'what we had stays visible',
        );
      },
    );

    testWidgets(
      'an unpaid job shows the area and "waiting for payment"; a paid one shows the customer',
      (tester) async {
        await _boot(
          tester,
          tab: 1,
          jobsTab: 2,
          arrange: (api) => api.workerJobList.addAll([
            job(
              id: 'unpaid',
              reference: 'HS-U',
              status: 'PAYMENT_PENDING',
              released: false,
            ),
            job(id: 'paid', reference: 'HS-P', status: 'CONFIRMED'),
          ]),
        );
        expect(find.text('Waiting for payment'), findsWidgets);
        expect(find.text('Confirmed'), findsOneWidget);
        // the customer's name rides along only for the paid job
        expect(find.textContaining('Sara'), findsOneWidget);
        expect(find.textContaining('King Fahd'), findsNothing);
      },
    );

    testWidgets(
      'another worker\'s jobs never appear: only what the backend lists',
      (tester) async {
        await _boot(tester, tab: 1, jobsTab: 2);
        expect(find.byKey(const Key('jobs-empty-2')), findsOneWidget);
      },
    );

    testWidgets('home shows the real counts and a retry when nothing loads', (
      tester,
    ) async {
      final ctx = await _boot(
        tester,
        arrange: (api) {
          api.workerRequestsResult = _api(0, 'NETWORK');
          api.workerJobsResult = _api(0, 'NETWORK');
        },
      );
      expect(find.byKey(const Key('home-failed')), findsOneWidget);
      ctx.api
        ..workerRequestsResult = null
        ..workerJobsResult = null
        ..workerRequestList.addAll([request(id: 'a'), request(id: 'b')])
        ..workerJobList.add(job());
      await _tapKey(tester, 'home-retry');
      expect(
        tester.widget<Text>(find.byKey(const Key('home-new-count'))).data,
        '2',
      );
      expect(find.byKey(const Key('home-job-job-1')), findsOneWidget);
    });
  });

  group('doing the job', () {
    testWidgets('start, then complete, using the backend\'s state each time', (
      tester,
    ) async {
      final ctx = await _boot(
        tester,
        home: const ActiveJobScreen(jobId: 'job-1', mapsEnabled: false),
        arrange: (api) => api.workerJobList.add(job()),
      );
      expect(find.byKey(const Key('job-status')), findsOneWidget);
      expect(find.text('Confirmed'), findsOneWidget);
      expect(find.text('Start job'), findsNothing);
      expect(find.text('I’ve arrived'), findsOneWidget);

      await _tapKey(tester, 'job-action');
      expect(ctx.api.calls.where((c) => c == 'arrivedWorkerJob'), hasLength(1));
      expect(ctx.api.calls.where((c) => c == 'startWorkerJob'), isEmpty);
      expect(ctx.api.workerJobList.single.status, 'CONFIRMED');
      expect(find.byKey(const Key('arrived-note')), findsOneWidget);
      expect(find.text('Start job'), findsOneWidget);

      await _tapKey(tester, 'job-action');
      expect(ctx.api.calls.where((c) => c == 'startWorkerJob'), hasLength(1));
      expect(find.text('In progress'), findsOneWidget);
      expect(find.text('Complete job'), findsOneWidget);

      await _tapKey(tester, 'job-action');
      expect(
        ctx.api.calls.where((c) => c == 'completeWorkerJob'),
        hasLength(1),
      );
      expect(find.byKey(const Key('job-finished')), findsOneWidget);
      expect(find.byKey(const Key('job-action')), findsNothing);
    });

    testWidgets('repeated taps on Start make one request', (tester) async {
      final ctx = await _boot(
        tester,
        home: const ActiveJobScreen(jobId: 'job-1', mapsEnabled: false),
        arrange: (api) => api.workerJobList.add(job()),
      );
      await _tapKey(tester, 'job-action'); // I've arrived
      for (var i = 0; i < 3; i++) {
        await tester.tap(
          find.byKey(const Key('job-action')),
          warnIfMissed: false,
        );
      }
      await _settle(tester);
      expect(ctx.api.calls.where((c) => c == 'arrivedWorkerJob'), hasLength(1));
      expect(ctx.api.calls.where((c) => c == 'startWorkerJob'), hasLength(1));
    });

    testWidgets('a refusal is shown and the job stays as the backend has it', (
      tester,
    ) async {
      final ctx = await _boot(
        tester,
        home: const ActiveJobScreen(jobId: 'job-1', mapsEnabled: false),
        arrange: (api) => api.workerJobList.add(job()),
      );
      ctx.api.jobActionResult = _api(0, 'NETWORK');
      await _tapKey(tester, 'job-action');
      expect(find.text('No connection. Try again.'), findsOneWidget);
      expect(find.text('I’ve arrived'), findsOneWidget);
      expect(ctx.api.workerJobList.single.status, 'CONFIRMED');
    });
  });

  group('nothing invented reaches a release build', () {
    testWidgets(
      'every tab shows no prototype names, jobs, amounts or ratings',
      (tester) async {
        for (final tab in [0, 1, 2, 3]) {
          final ctx = await _boot(tester, tab: tab);
          for (final invented in [
            'Faisal',
            'Sara Q.',
            'Mohammed A.',
            'AC Deep Cleaning',
            'Socket & Switch',
            'Hessa',
            'Nouf',
            '318',
            '#REQ-58213',
            'HS-240871',
          ]) {
            expect(
              find.textContaining(invented),
              findsNothing,
              reason: 'tab $tab shows "$invented"',
            );
          }
          expect(
            ctx.state.activeJobLocation,
            isNull,
            reason: 'the demo pin is not loaded',
          );
          await tester.pumpWidget(const SizedBox());
        }
      },
    );

    testWidgets(
      'earnings with no completed jobs shows zero and says so, with none of the prototype figures',
      (tester) async {
        await _boot(tester, tab: 2);
        expect(find.byKey(const Key('earnings-none')), findsOneWidget);
        expect(find.byKey(const Key('earnings-net')), findsOneWidget);
        expect(
          tester.widget<Text>(find.byKey(const Key('earnings-net'))).data,
          contains('0'),
        );
        expect(find.textContaining('0932'), findsNothing);
        expect(find.textContaining('8,960'), findsNothing);
        expect(find.textContaining('1,334'), findsNothing);
      },
    );
  });

  group('both languages', () {
    for (final tab in [0, 1]) {
      testWidgets('the worker tabs render in Arabic (tab $tab)', (
        tester,
      ) async {
        await _boot(
          tester,
          tab: tab,
          arabic: true,
          arrange: (api) => api.workerRequestList.add(request()),
        );
        expect(tester.takeException(), isNull);
        expect(find.textContaining('إصلاح المكيفات'), findsWidgets);
      });
    }

    testWidgets('the quote form and an unpaid job render in Arabic', (
      tester,
    ) async {
      await _boot(
        tester,
        home: SendQuoteScreen(request: request()),
        arabic: true,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await _boot(
        tester,
        home: const ActiveJobScreen(jobId: 'job-1', mapsEnabled: false),
        arabic: true,
        arrange: (api) => api.workerJobList.add(
          job(status: 'PAYMENT_PENDING', released: false),
        ),
      );
      expect(find.text('بانتظار دفع العميل'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
