import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/jobs/logic/worker_jobs_controller.dart';
import 'package:worker_app/features/jobs/screens/active_job_screen.dart';

import 'support/worker_harness.dart';

/// A customer who pays in cash: the worker sees the amount to collect, starts the job, and confirms receiving the cash.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  group('controller', () {
    Future<({TestHsClient kit, WorkerJobsController jobs})> rig(
      WorkerJob j,
    ) async {
      final kit = workerKit();
      await signInWorker(kit);
      kit.api.workerJobList.add(j);
      final s = makeJobsServices(kit);
      addTearDown(() {
        s.jobs.dispose();
        s.quotes.dispose();
        kit.client.auth.dispose();
      });
      await s.jobs.refresh();
      return (kit: kit, jobs: s.jobs);
    }

    test(
      'cash is confirmed only after the work has started, and the server\'s answer is what is shown',
      () async {
        final r = await rig(job(paymentMethod: 'CASH'));
        expect(r.jobs.jobById('job-1')!.canConfirmCash, isFalse);
        expect(
          await r.jobs.confirmCash('job-1'),
          JobActionOutcome.wrongState,
          reason: 'CONFIRMED: cash is not due yet',
        );

        await r.jobs.startJob('job-1');
        expect(r.jobs.jobById('job-1')!.canConfirmCash, isTrue);
        expect(await r.jobs.confirmCash('job-1'), JobActionOutcome.done);
        expect(r.jobs.jobById('job-1')!.cashCollectedAt, isNotNull);
        expect(r.jobs.jobById('job-1')!.canConfirmCash, isFalse);
      },
    );

    test('taps while confirming share one request', () async {
      final r = await rig(job(paymentMethod: 'CASH', status: 'IN_PROGRESS'));
      final results = await Future.wait([
        r.jobs.confirmCash('job-1'),
        r.jobs.confirmCash('job-1'),
        r.jobs.confirmCash('job-1'),
      ]);
      expect(results, everyElement(JobActionOutcome.done));
      expect(r.kit.api.cashConfirmed, hasLength(1));
    });

    test('a booking that is not paid in cash cannot confirm cash', () async {
      final r = await rig(job(status: 'IN_PROGRESS'));
      expect(r.jobs.jobById('job-1')!.canConfirmCash, isFalse);
      expect(await r.jobs.confirmCash('job-1'), JobActionOutcome.wrongState);
    });

    test('another worker\'s booking is not found', () async {
      final r = await rig(job(paymentMethod: 'CASH', status: 'IN_PROGRESS'));
      expect(
        await r.jobs.confirmCash('someone-elses'),
        JobActionOutcome.notFound,
      );
    });
  });

  if (kDemoData) return;

  group('screen', () {
    setUpAll(loadWorkerFonts);

    Future<TestHsClient> open(WidgetTester tester, WorkerJob j) async {
      phoneSize(tester, height: 1100);
      final kit = workerKit();
      await signInWorker(kit);
      kit.api.workerJobList.add(j);
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
          home: ActiveJobScreen(jobId: j.id, mapsEnabled: false),
        ),
      );
      await _settle(tester);
      return kit;
    }

    testWidgets(
      'a cash job tells the worker how much to collect, then start, then confirm receiving it',
      (tester) async {
        final kit = await open(tester, job(paymentMethod: 'CASH'));

        expect(find.byKey(const Key('cash-card')), findsOneWidget);
        expect(
          find.text('Collect SAR 287.50 in cash from the customer'),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('cash-collected')),
          findsNothing,
          reason: 'not before the work has started',
        );

        await tester.tap(find.byKey(const Key('job-action')));
        await _settle(tester);
        expect(find.byKey(const Key('cash-collected')), findsOneWidget);

        await tester.tap(find.byKey(const Key('cash-collected')));
        await _settle(tester);
        expect(kit.api.cashConfirmed, ['job-1']);
        expect(find.byKey(const Key('cash-collected')), findsNothing);
        expect(find.text('Cash received. Thank you.'), findsOneWidget);
      },
    );

    testWidgets('repeated taps on "I received the cash" make one request', (
      tester,
    ) async {
      final kit = await open(
        tester,
        job(paymentMethod: 'CASH', status: 'IN_PROGRESS'),
      );
      for (var i = 0; i < 3; i++) {
        await tester.tap(
          find.byKey(const Key('cash-collected')),
          warnIfMissed: false,
        );
      }
      await _settle(tester);
      expect(kit.api.cashConfirmed, hasLength(1));
    });

    testWidgets(
      'no cash card for an online booking or before the customer has paid',
      (tester) async {
        await open(tester, job());
        expect(find.byKey(const Key('cash-card')), findsNothing);
        await tester.pumpWidget(const SizedBox());
        await open(tester, job(status: 'PAYMENT_PENDING', released: false));
        expect(find.byKey(const Key('cash-card')), findsNothing);
      },
    );

    testWidgets(
      'a failed confirmation is reported and nothing is marked received',
      (tester) async {
        final kit = await open(
          tester,
          job(paymentMethod: 'CASH', status: 'IN_PROGRESS'),
        );
        kit.api.jobActionResult = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await tester.tap(find.byKey(const Key('cash-collected')));
        await _settle(tester);
        expect(find.text('No connection. Try again.'), findsOneWidget);
        expect(find.byKey(const Key('cash-collected')), findsOneWidget);
      },
    );

    testWidgets('renders in Arabic', (tester) async {
      await open(tester, job(paymentMethod: 'CASH', status: 'IN_PROGRESS'));
      expect(find.byKey(const Key('cash-card')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
