import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/app/jobs_scope.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/earnings/screens/earnings_screen.dart';
import 'package:worker_app/features/earnings/widgets/real_earnings.dart';
import 'package:worker_app/features/messages/screens/chat_screen.dart';
import 'package:worker_app/features/notifications/screens/notifications_screen.dart';
import 'package:worker_app/features/profile/screens/profile_screen.dart';
import 'package:worker_app/features/profile/widgets/real_profile.dart';

import 'support/worker_harness.dart';

/// What the worker's own account screens show: notifications, profile and earnings. Every figure and word comes from the (fake) server.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

NotificationItem _n(
  String id, {
  bool read = false,
  String type = 'request.new',
  String? booking = 'b-1',
  DateTime? at,
  String title = 'New request',
}) => NotificationItem(
  id: id,
  type: type,
  title: title,
  body: 'A new request matches your services and city.',
  resourceType: booking == null ? null : 'booking',
  resourceId: booking,
  read: read,
  createdAt: at ?? DateTime.now(),
);

WorkerJob _job(
  String id,
  String status, {
  int price = 20000,
  DateTime? completedAt,
  String service = 'AC repair',
}) => WorkerJob(
  id: id,
  reference: 'HS-$id',
  status: status,
  service: JobService(id: 'svc-ac', nameEn: service, nameAr: 'إصلاح'),
  location: paidPlace,
  isUrgent: false,
  preferredStartAt: DateTime.now().toUtc(),
  preferredEndAt: DateTime.now().toUtc().add(const Duration(hours: 2)),
  money: money(price: price),
  customerName: 'Sara',
  customerPhone: '+966500000000',
  completedAt: completedAt,
);

Future<(TestHsClient, JobsServices)> _open(
  WidgetTester tester,
  Widget screen, {
  void Function(FakeApi)? arrange,
  bool arabic = false,
  String? status,
}) async {
  tester.view.physicalSize = const Size(390 * 3, 1900 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final kit = TestHsClient(
    kind: AppKind.worker,
    user: fakeUser(
      role: 'WORKER',
      workerStatus: status,
      fullName: 'Faisal Al-Harbi',
    ),
  );
  await signInWorker(kit);
  arrange?.call(kit.api);
  final services = makeJobsServices(kit);
  addTearDown(() {
    services.jobs.dispose();
    services.quotes.dispose();
    services.notifications.dispose();
    services.reviews.dispose();
    kit.client.auth.dispose();
  });
  await tester.pumpWidget(
    workerHarness(
      kit: kit,
      services: services,
      state: AppState()..setArabic(arabic),
      home: screen,
      arabic: arabic,
    ),
  );
  await _settle(tester);
  return (kit, services);
}

void main() {
  if (kDemoData) return;
  setUpAll(loadWorkerFonts);

  group('the notification list', () {
    testWidgets(
      'lists what the server has with unread ones marked, in Today and Earlier',
      (tester) async {
        await _open(
          tester,
          const NotificationsScreen(),
          arrange: (api) => api.notificationList.addAll([
            _n('a', title: 'Your quote was accepted', type: 'quote.accepted'),
            _n(
              'b',
              read: true,
              title: 'Support replied',
              type: 'support.reply',
              booking: null,
              at: DateTime.now().subtract(const Duration(days: 3)),
            ),
          ]),
        );
        expect(find.text('Your quote was accepted'), findsOneWidget);
        expect(find.text('Support replied'), findsOneWidget);
        expect(find.byKey(const Key('unread-a')), findsOneWidget);
        expect(find.byKey(const Key('unread-b')), findsNothing);
        expect(find.text('TODAY'), findsOneWidget);
        expect(find.text('EARLIER'), findsOneWidget);
        expect(find.text('Faisal'), findsNothing);
      },
    );

    testWidgets(
      'opening a booking notification marks it read and asks the app to open that booking',
      (tester) async {
        final opened = <PushEvent>[];
        tester.view.physicalSize = const Size(390 * 3, 1900 * 3);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        final kit = TestHsClient(
          kind: AppKind.worker,
          user: fakeUser(role: 'WORKER'),
        );
        await signInWorker(kit);
        kit.api.notificationList.add(_n('a'));
        final base = makeJobsServices(kit);
        final services = JobsServices(
          jobs: base.jobs,
          quotes: base.quotes,
          sharer: base.sharer,
          notifications: base.notifications,
          reviews: base.reviews,
          openFromNotification: (e) async => opened.add(e),
        );
        addTearDown(() {
          services.jobs.dispose();
          services.quotes.dispose();
          services.notifications.dispose();
          services.reviews.dispose();
          kit.client.auth.dispose();
        });
        await tester.pumpWidget(
          workerHarness(
            kit: kit,
            services: services,
            state: AppState(),
            home: const NotificationsScreen(),
          ),
        );
        await _settle(tester);
        await tester.tap(find.byKey(const Key('notification-a')));
        await _settle(tester);
        expect(opened.single.type, 'request.new');
        expect(opened.single.resourceId, 'b-1');
        expect(kit.api.readNotifications, ['a']);
        expect(find.byKey(const Key('unread-a')), findsNothing);
      },
    );

    testWidgets(
      'a support reply and a decision on the application are opened too; an announcement is only marked read',
      (tester) async {
        final opened = <PushEvent>[];
        tester.view.physicalSize = const Size(390 * 3, 1900 * 3);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        final kit = TestHsClient(
          kind: AppKind.worker,
          user: fakeUser(role: 'WORKER'),
        );
        await signInWorker(kit);
        kit.api.notificationList.addAll([
          _n('s', type: 'support.reply', booking: null),
          _n('v', type: 'verification.approved', booking: null),
          _n('x', type: 'admin.announcement', booking: null),
        ]);
        final base = makeJobsServices(kit);
        final services = JobsServices(
          jobs: base.jobs,
          quotes: base.quotes,
          sharer: base.sharer,
          notifications: base.notifications,
          reviews: base.reviews,
          openFromNotification: (e) async => opened.add(e),
        );
        addTearDown(() {
          services.jobs.dispose();
          services.quotes.dispose();
          services.notifications.dispose();
          services.reviews.dispose();
          kit.client.auth.dispose();
        });
        await tester.pumpWidget(
          workerHarness(
            kit: kit,
            services: services,
            state: AppState(),
            home: const NotificationsScreen(),
          ),
        );
        await _settle(tester);
        for (final id in ['s', 'v', 'x']) {
          await tester.tap(find.byKey(Key('notification-$id')));
          await _settle(tester);
        }
        expect(opened.map((e) => e.type), [
          'support.reply',
          'verification.approved',
        ]);
        expect(opened.first.isSupportReply, isTrue);
        expect(opened.last.isVerification, isTrue);
        expect(kit.api.readNotifications, ['s', 'v', 'x']);
      },
    );

    testWidgets('mark all read', (tester) async {
      final (kit, _) = await _open(
        tester,
        const NotificationsScreen(),
        arrange: (api) => api.notificationList.addAll([_n('a'), _n('b')]),
      );
      await tester.tap(find.byKey(const Key('mark-all-read')));
      await _settle(tester);
      expect(kit.api.readAllCalled, isTrue);
      expect(find.byKey(const Key('mark-all-read')), findsNothing);
    });

    testWidgets('says so when there are none', (tester) async {
      await _open(tester, const NotificationsScreen());
      expect(find.text('No notifications yet'), findsOneWidget);
    });

    testWidgets('says so when loading failed, with a retry', (tester) async {
      final (kit, _) = await _open(
        tester,
        const NotificationsScreen(),
        arrange: (api) => api.notificationsResult = const ApiException(
          status: 0,
          code: 'NETWORK',
        ),
      );
      expect(find.text('Could not load notifications.'), findsOneWidget);
      kit.api.notificationsResult = null;
      kit.api.notificationList.add(_n('a', title: 'Back again'));
      await tester.tap(find.text('Try again'));
      await _settle(tester);
      expect(find.text('Back again'), findsOneWidget);
    });

    testWidgets('renders in Arabic', (tester) async {
      await _open(
        tester,
        const NotificationsScreen(),
        arabic: true,
        arrange: (api) => api.notificationList.add(_n('a')),
      );
      expect(find.text('الإشعارات'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('the profile', () {
    void application(FakeApi api, {String status = 'APPROVED'}) {
      api.fullName = 'Faisal Al-Harbi';
      api.yearsOfExperience = 8;
      api.workerStatus = status;
      api.workerServices.addAll(['svc-ac']);
      api.workerCities.addAll(['city-ruh', 'city-jed']);
      api.workerWindows.addAll([
        const AvailabilityWindow(
          dayOfWeek: 0,
          startTime: '08:00',
          endTime: '17:00',
        ),
        const AvailabilityWindow(
          dayOfWeek: 1,
          startTime: '08:00',
          endTime: '17:00',
        ),
        const AvailabilityWindow(
          dayOfWeek: 6,
          startTime: '10:00',
          endTime: '14:00',
        ),
      ]);
    }

    testWidgets(
      'shows the application: name, initials, status, experience, services, areas and hours',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          status: 'APPROVED',
          arrange: (api) => application(api),
        );
        expect(find.text('Faisal Al-Harbi'), findsOneWidget);
        expect(find.text('FA'), findsOneWidget);
        expect(find.text('Verified professional'), findsOneWidget);
        expect(find.text('8 yrs'), findsOneWidget);
        expect(find.text('AC repair'), findsOneWidget);
        expect(find.text('Riyadh, Jeddah'), findsOneWidget);
        expect(find.text('Sun, Mon · 8:00 AM – 5:00 PM'), findsOneWidget);
        expect(find.text('Sat · 10:00 AM – 2:00 PM'), findsOneWidget);
      },
    );

    testWidgets(
      'invents nothing: no payout account, no plan, no made-up reviews or ratings',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          status: 'APPROVED',
          arrange: (api) => application(api),
        );
        expect(find.textContaining('0932'), findsNothing);
        expect(find.text('Payout account'), findsNothing);
        expect(find.text('Subscription'), findsNothing);
        expect(find.text('PRO'), findsNothing);
        expect(find.text('Noura A.'), findsNothing);
        expect(find.text('4.9'), findsNothing);
        expect(find.byKey(const Key('profile-no-reviews')), findsOneWidget);
      },
    );

    testWidgets(
      'a worker still waiting for approval is shown as such, not as verified',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          status: 'UNDER_REVIEW',
          arrange: (api) => application(api, status: 'UNDER_REVIEW'),
        );
        expect(find.text('Verified professional'), findsNothing);
        expect(find.text('Under review'), findsWidgets);
      },
    );

    testWidgets(
      'an application with nothing filled in says "not set yet" rather than inventing areas',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          status: 'NOT_SUBMITTED',
        );
        expect(find.byKey(const Key('profile-no-services')), findsOneWidget);
        expect(find.text('Not set yet'), findsWidgets);
      },
    );

    testWidgets(
      'the rating, the number of reviews and the latest comments come from the server',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          status: 'APPROVED',
          arrange: (api) {
            application(api);
            api.receivedReviewsResult = const ReceivedReviews(
              count: 2,
              average: 4.5,
              items: [
                ReceivedReview(
                  id: 'r1',
                  rating: 5,
                  comment: 'On time and tidy',
                  createdAt: null,
                ),
                ReceivedReview(
                  id: 'r2',
                  rating: 4,
                  comment: null,
                  createdAt: null,
                ),
              ],
            );
          },
        );
        expect(find.text('4.5'), findsWidgets);
        expect(find.text(' · 2'), findsOneWidget);
        expect(find.text('On time and tidy'), findsOneWidget);
        expect(find.byKey(const Key('review-r1')), findsOneWidget);
        expect(find.byKey(const Key('review-r2')), findsOneWidget);
      },
    );

    testWidgets('Jobs done counts the completed jobs the server lists', (
      tester,
    ) async {
      await _open(
        tester,
        const Scaffold(body: ProfileScreen()),
        status: 'APPROVED',
        arrange: (api) {
          application(api);
          api.workerJobList.addAll([
            _job('1', 'COMPLETED', completedAt: DateTime.now()),
            _job('2', 'COMPLETED', completedAt: DateTime.now()),
            _job('3', 'CONFIRMED'),
          ]);
        },
      );
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('Notifications shows how many are new and opens the list', (
      tester,
    ) async {
      await _open(
        tester,
        const Scaffold(body: ProfileScreen()),
        status: 'APPROVED',
        arrange: (api) {
          application(api);
          api.notificationList.addAll([
            _n('a', title: 'Fresh one'),
            _n('b'),
            _n('c', read: true),
          ]);
        },
      );
      expect(find.text('2 new'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('profile-row-bell')));
      await tester.tap(find.byKey(const Key('profile-row-bell')));
      await _settle(tester);
      expect(find.byType(NotificationsScreen), findsOneWidget);
      expect(find.text('Fresh one'), findsOneWidget);
    });

    testWidgets('Help & support opens the conversation with the support team', (
      tester,
    ) async {
      final (kit, _) = await _open(
        tester,
        const Scaffold(body: ProfileScreen()),
        status: 'APPROVED',
        arrange: (api) => application(api),
      );
      await tester.ensureVisible(find.byKey(const Key('profile-row-help')));
      await tester.tap(find.byKey(const Key('profile-row-help')));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(kit.api.calls, contains('supportMessages'));
    });

    testWidgets('renders in Arabic', (tester) async {
      await _open(
        tester,
        const Scaffold(body: ProfileScreen()),
        arabic: true,
        status: 'APPROVED',
        arrange: (api) => application(api),
      );
      expect(tester.takeException(), isNull);
      expect(find.textContaining('الأحد'), findsWidgets);
    });

    test('describeSchedule groups days that share the same hours', () {
      final lines = describeSchedule(const [
        AvailabilityWindow(dayOfWeek: 2, startTime: '09:00', endTime: '18:00'),
        AvailabilityWindow(dayOfWeek: 0, startTime: '09:00', endTime: '18:00'),
        AvailabilityWindow(dayOfWeek: 5, startTime: '00:00', endTime: '12:30'),
      ], false);
      expect(lines, [
        'Sun, Tue · 9:00 AM – 6:00 PM',
        'Fri · 12:00 AM – 12:30 PM',
      ]);
      expect(describeSchedule(const [], false), isEmpty);
    });
  });

  group('earnings', () {
    // Wednesday 14 October 2026, 14:00 in Saudi Arabia (11:00 UTC).
    final now = DateTime.utc(2026, 10, 14, 11);

    test(
      'the periods start at Saudi midnight, six days back, and the first of the Saudi month',
      () {
        expect(periodStart(0, now), DateTime.utc(2026, 10, 13, 21));
        expect(periodStart(1, now), DateTime.utc(2026, 10, 7, 21));
        expect(periodStart(2, now), DateTime.utc(2026, 9, 30, 21));
        // 00:30 on the 1st in Saudi time is still the 30th in UTC
        expect(
          periodStart(2, DateTime.utc(2026, 10, 31, 21, 30)),
          DateTime.utc(2026, 10, 31, 21),
        );
      },
    );

    test(
      'summarize adds the server amounts of completed jobs inside the period only',
      () {
        final jobs = [
          _job(
            '1',
            'COMPLETED',
            price: 20000,
            completedAt: DateTime.utc(2026, 10, 14, 8),
          ),
          _job(
            '2',
            'COMPLETED',
            price: 10000,
            completedAt: DateTime.utc(2026, 10, 10, 8),
          ),
          _job(
            '3',
            'COMPLETED',
            price: 50000,
            completedAt: DateTime.utc(2026, 10, 1, 8),
          ),
          _job('4', 'CONFIRMED', price: 99999),
          _job('5', 'CANCELLED', price: 99999),
        ];
        final today = summarize(jobs, periodStart(0, now));
        expect(
          (
            today.jobs,
            today.grossHalalas,
            today.commissionHalalas,
            today.netHalalas,
          ),
          (1, 20000, 3000, 17000),
        );
        final week = summarize(jobs, periodStart(1, now));
        expect((week.jobs, week.netHalalas), (2, 17000 + 8500));
        final month = summarize(jobs, periodStart(2, now));
        expect((month.jobs, month.netHalalas), (3, 17000 + 8500 + 42500));
      },
    );

    test('the daily bars cover seven Saudi days ending today', () {
      final jobs = [
        _job(
          '1',
          'COMPLETED',
          price: 20000,
          completedAt: DateTime.utc(2026, 10, 14, 8),
        ),
        _job(
          '2',
          'COMPLETED',
          price: 10000,
          completedAt: DateTime.utc(2026, 10, 12, 8),
        ),
        _job(
          '3',
          'COMPLETED',
          price: 10000,
          completedAt: DateTime.utc(2026, 10, 7, 8),
        ),
      ];
      expect(lastSevenDays(jobs, now), [0, 0, 0, 0, 8500, 0, 17000]);
    });

    testWidgets(
      'shows what the completed jobs earned in each period, what is still ahead, and the recent jobs',
      (tester) async {
        final base = DateTime.now().toUtc();
        await _open(
          tester,
          const EarningsScreen(),
          arrange: (api) => api.workerJobList.addAll([
            _job(
              '1',
              'COMPLETED',
              price: 20000,
              completedAt: base.subtract(const Duration(minutes: 5)),
              service: 'AC repair',
            ),
            _job(
              '2',
              'COMPLETED',
              price: 10000,
              completedAt: base.subtract(const Duration(days: 3)),
              service: 'Plumbing',
            ),
            _job('3', 'CONFIRMED', price: 30000),
          ]),
        );
        // week is selected first: both completed jobs
        expect(find.byKey(const Key('earnings-hero')), findsOneWidget);
        expect(find.byKey(const Key('earnings-jobs')), findsOneWidget);
        expect(
          tester.widget<Text>(find.byKey(const Key('earnings-jobs'))).data,
          '2',
        );
        expect(find.textContaining('255'), findsWidgets); // 170 + 85
        expect(
          tester.widget<Text>(find.byKey(const Key('earnings-ahead'))).data,
          contains('255'),
        );
        expect(find.byKey(const Key('earned-1')), findsOneWidget);
        expect(find.byKey(const Key('earned-2')), findsOneWidget);
        expect(find.byKey(const Key('earned-3')), findsNothing);
        expect(find.byKey(const Key('earnings-how')), findsOneWidget);
        expect(find.textContaining('0932'), findsNothing);
      },
    );

    testWidgets('switching to Today narrows it to today', (tester) async {
      final base = DateTime.now().toUtc();
      await _open(
        tester,
        const EarningsScreen(),
        arrange: (api) => api.workerJobList.addAll([
          _job(
            '1',
            'COMPLETED',
            price: 20000,
            completedAt: base.subtract(const Duration(seconds: 1)),
          ),
          _job(
            '2',
            'COMPLETED',
            price: 10000,
            completedAt: base.subtract(const Duration(days: 3)),
          ),
        ]),
      );
      await tester.tap(find.text('Today').first);
      await _settle(tester);
      expect(
        tester.widget<Text>(find.byKey(const Key('earnings-jobs'))).data,
        anyOf('1', '0'),
      ); // 1, unless the test runs within a second of Saudi midnight
    });

    testWidgets(
      'says so when there is nothing yet, and when the list could not be loaded',
      (tester) async {
        await _open(tester, const EarningsScreen());
        expect(find.byKey(const Key('earnings-none')), findsOneWidget);
      },
    );

    testWidgets('a failed load offers a retry', (tester) async {
      final (kit, _) = await _open(
        tester,
        const EarningsScreen(),
        arrange: (api) => api.workerJobsResult = const ApiException(
          status: 0,
          code: 'NETWORK',
        ),
      );
      expect(find.byKey(const Key('earnings-failed')), findsOneWidget);
      kit.api.workerJobsResult = null;
      kit.api.workerJobList.add(
        _job('1', 'COMPLETED', completedAt: DateTime.now().toUtc()),
      );
      await tester.tap(find.text('Try again'));
      await _settle(tester);
      expect(find.byKey(const Key('earnings-failed')), findsNothing);
      expect(find.byKey(const Key('earned-1')), findsOneWidget);
    });

    testWidgets('renders in Arabic', (tester) async {
      await _open(
        tester,
        const EarningsScreen(),
        arabic: true,
        arrange: (api) => api.workerJobList.add(
          _job('1', 'COMPLETED', completedAt: DateTime.now().toUtc()),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('الأرباح'), findsOneWidget);
    });
  });
}
