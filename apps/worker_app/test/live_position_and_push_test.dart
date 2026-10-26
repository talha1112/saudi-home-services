import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/app/jobs_scope.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/jobs/logic/position_sharer.dart';
import 'package:worker_app/features/jobs/screens/active_job_screen.dart';
import 'package:worker_app/features/messages/screens/chat_screen.dart';
import 'package:worker_app/features/requests/screens/request_detail_screen.dart';

import 'support/worker_harness.dart';

/// The worker's side of the live booking: the position they send to the customer, and what a push about the booking does.
PositionReading _fix(
  DateTime at, {
  double lat = 24.7136,
  double lng = 46.6753,
}) => PositionReading(
  latitude: lat,
  longitude: lng,
  at: at,
  accuracyMeters: 8,
  headingDegrees: 90,
  speedMps: 3,
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

WorkerJob _jobStarting(String id, String status, Duration fromNow) => WorkerJob(
  id: id,
  reference: 'HS-$id',
  status: status,
  service: const JobService(id: 'svc-ac', nameEn: 'AC repair', nameAr: 'إصلاح'),
  location: paidPlace,
  isUrgent: false,
  preferredStartAt: DateTime.now().toUtc().add(fromNow),
  preferredEndAt: DateTime.now().toUtc().add(
    fromNow + const Duration(hours: 2),
  ),
  money: money(),
  customerName: 'Sara',
  customerPhone: '+966500000000',
);

Future<({PositionSharer sharer, FakeApi api})> _unapprovedKit() async {
  final kit = TestHsClient(
    kind: AppKind.worker,
    user: fakeUser(role: 'WORKER', workerStatus: 'SUBMITTED'),
  );
  await signInWorker(kit);
  kit.api.workerJobList.add(_jobStarting('j1', 'IN_PROGRESS', Duration.zero));
  final services = makeJobsServices(
    kit,
    source: FakePositionSource()..reading = _fix(DateTime.now().toUtc()),
  );
  addTearDown(() {
    services.jobs.dispose();
    services.quotes.dispose();
    services.sharer.dispose();
    kit.client.auth.dispose();
  });
  return (sharer: services.sharer, api: kit.api);
}

void main() {
  group('the position sent to the customer', () {
    late TestHsClient kit;
    late FakePositionSource source;
    late JobsServices services;

    Future<void> setUpSharer({
      List<WorkerJob> jobs = const [],
      bool approved = true,
    }) async {
      kit = approved
          ? workerKit()
          : TestHsClient(
              kind: AppKind.worker,
              user: fakeUser(role: 'WORKER', workerStatus: 'SUBMITTED'),
            );
      await signInWorker(kit);
      kit.api.workerJobList.addAll(jobs);
      source = FakePositionSource()..reading = _fix(DateTime.now().toUtc());
      services = makeJobsServices(kit, source: source);
      addTearDown(() {
        services.jobs.dispose();
        services.quotes.dispose();
        services.sharer.dispose();
        kit.client.auth.dispose();
      });
    }

    PositionSharer sharer() => services.sharer;

    test(
      'a paid job close to its time: the phone\'s position goes to the backend for that booking',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'CONFIRMED', const Duration(minutes: 40))],
        );
        await sharer().tick();

        expect(kit.api.reportedPositions, hasLength(1));
        final sent = kit.api.reportedPositions.single;
        expect(sent.bookingId, 'j1');
        expect(sent.latitude, 24.7136);
        expect(sent.longitude, 46.6753);
        expect(sent.accuracy, 8);
        expect(sharer().state, SharingState.sharing);
        expect(sharer().lastSentAt, isNotNull);
      },
    );

    test(
      'a job under way is always shared; a job days away is not (and the permission is not even asked)',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('far', 'CONFIRMED', const Duration(days: 2))],
        );
        await sharer().tick();
        expect(kit.api.reportedPositions, isEmpty);
        expect(source.requests, 0);
        expect(sharer().state, SharingState.idle);

        kit.api.workerJobList
          ..clear()
          ..add(_jobStarting('now', 'IN_PROGRESS', const Duration(days: -1)));
        await services.jobs.loadJobs();
        await sharer().tick();
        expect(kit.api.reportedPositions.single.bookingId, 'now');
      },
    );

    test(
      'a job that is not yet paid, finished or cancelled is never shared',
      () async {
        await setUpSharer(
          jobs: [
            _jobStarting('a', 'PAYMENT_PENDING', const Duration(minutes: 30)),
            _jobStarting('b', 'COMPLETED', const Duration(minutes: -30)),
            _jobStarting('c', 'CANCELLED', const Duration(minutes: 30)),
          ],
        );
        await sharer().tick();
        expect(kit.api.reportedPositions, isEmpty);
      },
    );

    test(
      'without permission nothing is sent, the state says so, and "turn on" asks again',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
        );
        source.access = PositionAccess.denied;
        await sharer().tick();
        expect(sharer().state, SharingState.needsPermission);
        expect(kit.api.reportedPositions, isEmpty);

        source.access = PositionAccess.granted;
        await sharer().fixPermission();
        expect(sharer().state, SharingState.sharing);
        expect(kit.api.reportedPositions, hasLength(1));
      },
    );

    test(
      '"don\'t ask again" or location switched off opens the phone settings instead',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
        );
        source.access = PositionAccess.deniedForever;
        await sharer().tick();
        await sharer().fixPermission();
        expect(source.settingsOpened, 1);
        expect(kit.api.reportedPositions, isEmpty);
      },
    );

    test(
      'no position could be read: it keeps trying, and sends nothing made up',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
        );
        source.reading = null;
        await sharer().tick();
        expect(sharer().state, SharingState.trying);
        expect(kit.api.reportedPositions, isEmpty);
      },
    );

    test(
      'the backend saying sharing is not open pauses that job instead of asking every few seconds',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'CONFIRMED', const Duration(minutes: 30))],
        );
        kit.api.reportResult = const ApiException(
          status: 409,
          code: 'LOCATION_SHARING_NOT_ACTIVE',
        );
        await sharer().tick();
        expect(kit.api.reportedPositions, hasLength(1));
        await sharer().tick();
        await sharer().tick();
        expect(
          kit.api.reportedPositions,
          hasLength(1),
          reason: 'paused for a minute',
        );
      },
    );

    test(
      'a refused or lost report is skipped and the next round sends a fresh one',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
        );
        kit.api.reportResult = const ApiException(status: 0, code: 'NETWORK');
        await sharer().tick();
        expect(sharer().state, SharingState.trying);
        kit.api.reportResult = null;
        await sharer().tick();
        expect(sharer().state, SharingState.sharing);
        expect(kit.api.reportedPositions, hasLength(2));
      },
    );

    test(
      'nothing is sent while the app is in the background, or by a worker who is not approved',
      () async {
        await setUpSharer(
          jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
        );
        sharer().setForeground(false);
        await sharer().tick();
        expect(kit.api.reportedPositions, isEmpty);

        final unapproved = await _unapprovedKit();
        await unapproved.sharer.tick();
        expect(unapproved.api.calls, isNot(contains('workerJobs')));
        expect(unapproved.api.reportedPositions, isEmpty);
      },
    );

    test('when the job ends the sharing goes idle', () async {
      await setUpSharer(
        jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
      );
      await sharer().tick();
      expect(sharer().state, SharingState.sharing);
      await services.jobs.startJob('j1').then((_) {}, onError: (_) {});
      kit.api.workerJobList[0] = _jobStarting('j1', 'COMPLETED', Duration.zero);
      await services.jobs.loadJobs();
      await sharer().tick();
      expect(sharer().state, SharingState.idle);
    });

    test('overlapping rounds do not double-send', () async {
      await setUpSharer(
        jobs: [_jobStarting('j1', 'IN_PROGRESS', Duration.zero)],
      );
      await Future.wait([sharer().tick(), sharer().tick(), sharer().tick()]);
      expect(kit.api.reportedPositions, hasLength(1));
    });
  });

  if (kDemoData) return;
  setUpAll(loadWorkerFonts);

  group('the job screen shows whether the customer can see the worker', () {
    Future<({TestHsClient kit, JobsServices services})> open(
      WidgetTester tester,
      WorkerJob job, {
      PositionAccess access = PositionAccess.granted,
    }) async {
      phoneSize(tester, height: 1000);
      final kit = workerKit();
      await signInWorker(kit);
      kit.api.workerJobList.add(job);
      final source = FakePositionSource()
        ..access = access
        ..reading = _fix(DateTime.now().toUtc());
      final services = makeJobsServices(kit, source: source);
      addTearDown(() {
        services.jobs.dispose();
        services.quotes.dispose();
        services.sharer.dispose();
        kit.client.auth.dispose();
      });
      await tester.pumpWidget(
        workerHarness(
          kit: kit,
          services: services,
          state: AppState(),
          home: ActiveJobScreen(jobId: job.id, mapsEnabled: false),
        ),
      );
      await _settle(tester);
      await tester.runAsync(() => services.sharer.tick());
      await _settle(tester);
      return (kit: kit, services: services);
    }

    testWidgets('sharing: says so', (tester) async {
      await open(tester, _jobStarting('j1', 'IN_PROGRESS', Duration.zero));
      expect(
        find.text('Sharing your live location with the customer'),
        findsOneWidget,
      );
    });

    testWidgets(
      'location off: says the customer cannot see the worker, and offers to turn it on',
      (tester) async {
        await open(
          tester,
          _jobStarting('j1', 'IN_PROGRESS', Duration.zero),
          access: PositionAccess.denied,
        );
        expect(find.byKey(const Key('sharing-fix')), findsOneWidget);
        expect(
          find.textContaining('the customer cannot see you'),
          findsOneWidget,
        );
      },
    );

    testWidgets('a job that is not paid shows nothing about it', (
      tester,
    ) async {
      await open(
        tester,
        _jobStarting('j1', 'PAYMENT_PENDING', const Duration(minutes: 30)),
      );
      expect(find.byKey(const Key('sharing-status')), findsNothing);
    });

    testWidgets(
      'the screen follows the booking: a status change on the server shows up without a tap',
      (tester) async {
        final ctx = await open(
          tester,
          _jobStarting('j1', 'CONFIRMED', const Duration(minutes: 30)),
        );
        expect(find.text('Confirmed'), findsOneWidget);
        ctx.kit.api.workerJobList[0] = _jobStarting(
          'j1',
          'CANCELLED',
          const Duration(minutes: 30),
        );
        await tester.pump(const Duration(seconds: 9));
        await _settle(tester);
        expect(find.text('Cancelled'), findsOneWidget);
      },
    );
  });

  group('a push about a booking', () {
    Future<TestHsClient> launch(
      WidgetTester tester, {
      void Function(FakeApi)? arrange,
    }) async {
      phoneSize(tester, height: 1000);
      final kit = workerKit();
      kit.api.workerStatus = 'APPROVED';
      await signInWorker(kit);
      arrange?.call(kit.api);
      addTearDown(kit.client.auth.dispose);
      await tester.pumpWidget(
        App(client: kit.client, positionSource: FakePositionSource()),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await _settle(tester);
      return kit;
    }

    PushEvent event(String type, String bookingId) => PushEvent(
      notificationId: '$type-$bookingId',
      type: type,
      resourceType: 'booking',
      resourceId: bookingId,
      title: 'Title $type',
      body: 'Body',
    );

    testWidgets(
      'while the app is open: the lists refresh and the worker is told, with a way in',
      (tester) async {
        final kit = await launch(tester);
        final before = kit.api.calls.where((c) => c == 'workerRequests').length;
        kit.api.workerRequestList.add(request(id: 'req-9', reference: 'HS-9'));

        kit.push.foregroundEvents.add(event('request.new', 'req-9'));
        await _settle(tester);

        expect(
          kit.api.calls.where((c) => c == 'workerRequests').length,
          greaterThan(before),
        );
        expect(find.byKey(const Key('push-snackbar')), findsOneWidget);
        expect(find.textContaining('Title request.new'), findsOneWidget);
      },
    );

    testWidgets('tapping "new request" opens that request', (tester) async {
      final kit = await launch(
        tester,
        arrange: (api) =>
            api.workerRequestList.add(request(id: 'req-9', reference: 'HS-9')),
      );
      kit.push.openedEvents.add(event('request.new', 'req-9'));
      await _settle(tester);
      expect(find.byType(RequestDetailScreen), findsOneWidget);
      expect(find.text('AC repair'), findsWidgets);
    });

    testWidgets(
      'tapping "your quote was accepted" or "payment confirmed" opens the job',
      (tester) async {
        final kit = await launch(
          tester,
          arrange: (api) =>
              api.workerJobList.add(job(id: 'job-1', paymentMethod: 'CASH')),
        );
        kit.push.openedEvents.add(event('payment.confirmed', 'job-1'));
        await _settle(tester);
        expect(find.byType(ActiveJobScreen), findsOneWidget);
        expect(find.byKey(const Key('job-status')), findsOneWidget);
      },
    );

    testWidgets(
      'tapping a chat message opens that booking\'s chat with the customer',
      (tester) async {
        final kit = await launch(
          tester,
          arrange: (api) {
            api.workerJobList.add(job(id: 'job-1'));
            api.chatBookings.add('job-1');
            api.chatPeerMessage('job-1', 'I am at the gate');
          },
        );
        kit.push.openedEvents.add(event('chat.message', 'job-1'));
        await _settle(tester);
        expect(find.byType(ChatScreen), findsOneWidget);
        expect(find.text('I am at the gate'), findsOneWidget);
        expect(find.text('Sara'), findsOneWidget);
      },
    );

    testWidgets(
      'a booking that is not this worker\'s lands on the job list instead of a broken screen',
      (tester) async {
        final kit = await launch(tester);
        kit.push.openedEvents.add(event('payment.confirmed', 'someone-elses'));
        await _settle(tester);
        expect(find.byType(ActiveJobScreen), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  });
}
