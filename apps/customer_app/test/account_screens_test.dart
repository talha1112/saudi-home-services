import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/app/booking_scope.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/features/bookings/screens/booking_detail_screen.dart';
import 'package:customer_app/features/home/screens/home_screen.dart';
import 'package:customer_app/features/messages/screens/chat_screen.dart';
import 'package:customer_app/features/notifications/screens/notifications_screen.dart';
import 'package:customer_app/features/offers/screens/offers_screen.dart';
import 'package:customer_app/features/profile/screens/profile_screen.dart';
import 'package:customer_app/features/services/screens/services_screen.dart';
import 'package:customer_app/shared/widgets/tiles.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

import 'support/booking_harness.dart';

/// What the customer's own account screens show: the bell and its list, the profile, the offers, the booking on Home and the review of a
/// finished booking. Every figure and word here comes from the (fake) server, never from the app.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

NotificationItem _n(
  String id, {
  bool read = false,
  String type = 'quote.received',
  String? booking = 'b-1',
  DateTime? at,
  String title = 'New quote received',
}) => NotificationItem(
  id: id,
  type: type,
  title: title,
  body: 'About booking BK-1',
  resourceType: booking == null ? null : 'booking',
  resourceId: booking,
  read: read,
  createdAt: at ?? DateTime.now(),
);

BookingSummary _summary(String id, String status, {int hoursAhead = 5}) =>
    BookingSummary(
      id: id,
      reference: 'BK-$id',
      status: status,
      serviceId: 's-1',
      serviceNameEn: 'AC repair',
      serviceNameAr: 'إصلاح المكيف',
      cityId: 'c-1',
      isUrgent: false,
      preferredStartAt: DateTime.now().add(Duration(hours: hoursAhead)),
      preferredEndAt: DateTime.now().add(Duration(hours: hoursAhead + 2)),
      createdAt: DateTime.now(),
      quoteCount: 0,
    );

Future<(TestHsClient, dynamic)> _open(
  WidgetTester tester,
  Widget screen, {
  String? name,
  void Function(FakeApi)? arrange,
  bool arabic = false,
}) async {
  phoneSize(tester, height: 1800);
  final kit = TestHsClient(user: fakeUser(fullName: name));
  await signIn(kit);
  arrange?.call(kit.api);
  final services = makeServices(kit);
  addTearDown(() {
    services.catalog.dispose();
    services.submitter.dispose();
    services.bookings.dispose();
    services.notifications.dispose();
    services.offers.dispose();
    kit.client.auth.dispose();
  });
  await tester.pumpWidget(
    harness(
      kit: kit,
      services: services,
      state: AppState()..setArabic(arabic),
      arabic: arabic,
      home: screen,
    ),
  );
  await _settle(tester);
  return (kit, services);
}

void main() {
  if (kDemoData) return;
  setUpAll(loadAppFonts);

  group('the bell on Home', () {
    testWidgets(
      'shows a dot only while the server counts unread notifications',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: HomeScreen()),
          arrange: (api) =>
              api.notificationList.addAll([_n('a'), _n('b', read: true)]),
        );
        expect(find.byKey(const Key('bell-unread')), findsOneWidget);
      },
    );

    testWidgets('no dot when everything is read', (tester) async {
      await _open(
        tester,
        const Scaffold(body: HomeScreen()),
        arrange: (api) => api.notificationList.add(_n('a', read: true)),
      );
      expect(find.byKey(const Key('bell-unread')), findsNothing);
    });

    testWidgets('tapping it opens the list of notifications', (tester) async {
      await _open(
        tester,
        const Scaffold(body: HomeScreen()),
        arrange: (api) => api.notificationList.addAll([
          _n('a', title: 'Payment confirmed', type: 'payment.confirmed'),
        ]),
      );
      await tester.tap(
        find.byWidgetPredicate(
          (w) => w is SquareIconButton && w.icon == 'bell',
        ),
      );
      await _settle(tester);
      expect(find.byType(NotificationsScreen), findsOneWidget);
      expect(find.text('Payment confirmed'), findsOneWidget);
    });
  });

  group('the notification list', () {
    testWidgets(
      'lists what the server has, newest first, with unread ones marked',
      (tester) async {
        await _open(
          tester,
          const NotificationsScreen(),
          arrange: (api) => api.notificationList.addAll([
            _n('a', title: 'Payment confirmed', type: 'payment.confirmed'),
            _n(
              'b',
              read: true,
              title: 'Work completed',
              type: 'work.completed',
              at: DateTime.now().subtract(const Duration(days: 3)),
            ),
          ]),
        );
        expect(find.text('Payment confirmed'), findsOneWidget);
        expect(find.text('Work completed'), findsOneWidget);
        expect(find.byKey(const Key('unread-a')), findsOneWidget);
        expect(find.byKey(const Key('unread-b')), findsNothing);
        expect(find.text('TODAY'), findsOneWidget);
        expect(find.text('EARLIER'), findsOneWidget);
      },
    );

    testWidgets(
      'opening a booking notification marks it read and opens that booking',
      (tester) async {
        final opened = <PushEvent>[];
        phoneSize(tester, height: 1800);
        final kit = TestHsClient();
        await signIn(kit);
        kit.api.notificationList.add(_n('a'));
        final base = makeServices(kit);
        final services = BookingServices(
          catalog: base.catalog,
          submitter: base.submitter,
          bookings: base.bookings,
          detailFor: base.detailFor,
          positionFor: base.positionFor,
          notifications: base.notifications,
          offers: base.offers,
          openFromNotification: (e) async => opened.add(e),
        );
        addTearDown(() {
          services.catalog.dispose();
          services.submitter.dispose();
          services.bookings.dispose();
          services.notifications.dispose();
          services.offers.dispose();
          kit.client.auth.dispose();
        });
        await tester.pumpWidget(
          harness(
            kit: kit,
            services: services,
            state: AppState(),
            home: const NotificationsScreen(),
          ),
        );
        await _settle(tester);
        await tester.tap(find.byKey(const Key('notification-a')));
        await _settle(tester);
        expect(opened.single.type, 'quote.received');
        expect(opened.single.resourceId, 'b-1');
        expect(opened.single.isBooking, isTrue);
        expect(kit.api.readNotifications, ['a']);
        expect(find.byKey(const Key('unread-a')), findsNothing);
      },
    );

    testWidgets(
      'a notification that is not about a booking is only marked read',
      (tester) async {
        final (kit, _) = await _open(
          tester,
          const NotificationsScreen(),
          arrange: (api) => api.notificationList.add(
            _n(
              'x',
              type: 'admin.announcement',
              booking: null,
              title: 'Hello everyone',
            ),
          ),
        );
        await tester.tap(find.byKey(const Key('notification-x')));
        await _settle(tester);
        expect(kit.api.readNotifications, ['x']);
      },
    );

    testWidgets('mark all read, and nothing to mark when all are read', (
      tester,
    ) async {
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

    testWidgets('says so when loading failed, with a way to retry', (
      tester,
    ) async {
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
    testWidgets(
      'shows the name, its initials and the phone from the account, not invented ones',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          name: 'Sara Al-Qahtani',
        );
        expect(find.byKey(const Key('profile-name')), findsOneWidget);
        expect(find.text('Sara Al-Qahtani'), findsWidgets);
        expect(find.text('SA'), findsOneWidget);
        expect(find.text('+966 50 123 4567'), findsWidgets);
        expect(find.text('+966 55 123 4567'), findsNothing);
        expect(find.text('Saved addresses'), findsNothing);
        expect(find.text('Cash on delivery'), findsOneWidget);
      },
    );

    testWidgets('a customer without a name is asked to add one', (
      tester,
    ) async {
      await _open(tester, const Scaffold(body: ProfileScreen()));
      expect(find.text('Add your name'), findsOneWidget);
    });

    testWidgets(
      'Edit saves the name on the server and the screen shows it at once',
      (tester) async {
        final (kit, _) = await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          name: 'Sara',
        );
        await tester.tap(find.byKey(const Key('profile-edit')));
        await _settle(tester);
        await tester.enterText(
          find.byKey(const Key('profile-name-field')),
          '  Sara   Al-Qahtani ',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('profile-name-save')));
        await _settle(tester);
        expect(kit.api.lastUpdatedName, 'Sara Al-Qahtani');
        expect(find.text('Sara Al-Qahtani'), findsWidgets);
        expect(find.text('Name saved'), findsOneWidget);
      },
    );

    testWidgets(
      'a name that is too short cannot be sent; a refused one shows the problem and keeps the old name',
      (tester) async {
        final (kit, _) = await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          name: 'Sara',
        );
        await tester.tap(find.byKey(const Key('profile-edit')));
        await _settle(tester);
        await tester.enterText(
          find.byKey(const Key('profile-name-field')),
          'S',
        );
        await tester.pump();
        await tester.tap(
          find.byKey(const Key('profile-name-save')),
          warnIfMissed: false,
        );
        await _settle(tester);
        expect(kit.api.calls, isNot(contains('updateCustomerName')));

        kit.api.updateNameResult = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await tester.enterText(
          find.byKey(const Key('profile-name-field')),
          'Sara Q',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('profile-name-save')));
        await _settle(tester);
        expect(find.byKey(const Key('profile-name-error')), findsOneWidget);
        expect(kit.client.auth.user!.fullName, 'Sara');
      },
    );

    testWidgets(
      'My bookings shows how many bookings the server lists; Notifications shows how many are new',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          name: 'Sara',
          arrange: (api) {
            api.bookingList.addAll([
              _summary('1', 'OPEN'),
              _summary('2', 'COMPLETED'),
            ]);
            api.notificationList.addAll([
              _n('a'),
              _n('b'),
              _n('c', read: true),
            ]);
          },
        );
        expect(find.text('2'), findsOneWidget);
        expect(find.text('2 new'), findsOneWidget);
      },
    );

    testWidgets(
      'Help & support opens the customer conversation with the support team',
      (tester) async {
        final (kit, _) = await _open(
          tester,
          const Scaffold(body: ProfileScreen()),
          name: 'Sara',
        );
        await tester.ensureVisible(find.text('Help & support'));
        await tester.tap(find.text('Help & support'));
        await _settle(tester);
        expect(find.byType(ChatScreen), findsOneWidget);
        expect(kit.api.calls, contains('supportMessages'));
        expect(
          find.text('Tell us how we can help. Our team replies here.'),
          findsOneWidget,
        );
      },
    );
  });

  group('offers', () {
    testWidgets(
      'lists the offers the server says are showing, with their words and when they end',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: OffersScreen()),
          arrange: (api) => api.offerList.add(
            OfferItem(
              id: 'o-1',
              title: '20% off AC cleaning',
              description: 'Any number of units',
              terms: '20% OFF',
              startsAt: DateTime.utc(2026, 10, 1),
              endsAt: DateTime.utc(2030, 11, 15, 12),
            ),
          ),
        );
        expect(find.byKey(const Key('offer-o-1')), findsOneWidget);
        expect(find.text('20% off AC cleaning'), findsOneWidget);
        expect(find.text('Any number of units'), findsOneWidget);
        expect(find.textContaining('Ends 15 Nov'), findsOneWidget);
        expect(find.text('AC20'), findsNothing); // no invented code
      },
    );

    testWidgets('says so when there are none', (tester) async {
      await _open(tester, const Scaffold(body: OffersScreen()));
      expect(find.text('No offers right now'), findsOneWidget);
    });

    testWidgets('offers a retry when loading failed', (tester) async {
      final (kit, _) = await _open(
        tester,
        const Scaffold(body: OffersScreen()),
        arrange: (api) => api.offersResult = const ApiException(
          status: 503,
          code: 'UNAVAILABLE',
        ),
      );
      expect(find.text('Could not load offers.'), findsOneWidget);
      kit.api.offersResult = null;
      kit.api.offerList.add(
        OfferItem(
          id: 'o-2',
          title: 'Back',
          description: '',
          terms: '',
          startsAt: null,
          endsAt: null,
        ),
      );
      await tester.tap(find.text('Try again'));
      await _settle(tester);
      expect(find.text('Back'), findsOneWidget);
    });
  });

  group('Home', () {
    testWidgets(
      'shows the paid booking that is coming up, from the server list, and opens it',
      (tester) async {
        await _open(
          tester,
          const Scaffold(body: HomeScreen()),
          name: 'Sara',
          arrange: (api) => api.bookingList.addAll([
            _summary('1', 'OPEN'),
            _summary('2', 'CONFIRMED'),
          ]),
        );
        expect(find.byKey(const Key('home-active-booking')), findsOneWidget);
        expect(find.text('Confirmed'), findsOneWidget);
        expect(find.text('AC repair'), findsWidgets);
        expect(find.text('Sara'), findsOneWidget);
      },
    );

    testWidgets('a booking under way comes before one that is only confirmed', (
      tester,
    ) async {
      await _open(
        tester,
        const Scaffold(body: HomeScreen()),
        arrange: (api) => api.bookingList.addAll([
          _summary('1', 'CONFIRMED', hoursAhead: 1),
          _summary('2', 'IN_PROGRESS', hoursAhead: 9),
        ]),
      );
      expect(find.text('In progress'), findsOneWidget);
      expect(find.text('Confirmed'), findsNothing);
    });

    testWidgets('no card when nothing is paid and active', (tester) async {
      await _open(
        tester,
        const Scaffold(body: HomeScreen()),
        arrange: (api) => api.bookingList.addAll([
          _summary('1', 'OPEN'),
          _summary('2', 'COMPLETED'),
          _summary('3', 'CANCELLED'),
        ]),
      );
      expect(find.byKey(const Key('home-active-booking')), findsNothing);
    });
  });

  group('the review of a finished booking', () {
    BookingDetail completed() => BookingDetail(
      id: 'b-1',
      reference: 'BK-1',
      status: 'COMPLETED',
      serviceNameEn: 'AC repair',
      serviceNameAr: 'إصلاح',
      location: const BookingLocation(cityId: 'c', addressLine: 'King Fahd Rd'),
      isUrgent: false,
      problemDescription: 'Weak cooling',
      money: const CustomerMoney(
        currency: 'SAR',
        serviceHalalas: 20000,
        vatHalalas: 3000,
        totalHalalas: 23000,
        vatRateBps: 1500,
      ),
      worker: const AssignedWorker(
        workerId: 'w',
        fullName: 'Faisal',
        phone: '+966500000001',
      ),
      acceptedQuoteId: 'q',
      paymentMethod: 'CASH',
    );

    Future<TestHsClient> screen(
      WidgetTester tester,
      void Function(FakeApi) arrange,
    ) async {
      final (kit, _) = await _open(
        tester,
        const BookingDetailScreen(bookingId: 'b-1'),
        arrange: (api) {
          api.detailStore['b-1'] = completed();
          arrange(api);
        },
      );
      return kit;
    }

    testWidgets(
      'a booking with no review yet asks for stars and a comment, and sends them',
      (tester) async {
        final kit = await screen(tester, (_) {});
        expect(find.byKey(const Key('review-card')), findsOneWidget);
        await tester.ensureVisible(find.byKey(const Key('star-4')));
        await tester.tap(find.byKey(const Key('star-4')));
        await tester.pump();
        await tester.enterText(
          find.byKey(const Key('review-comment-field')),
          'Arrived on time',
        );
        await tester.ensureVisible(find.byKey(const Key('review-submit')));
        await tester.tap(find.byKey(const Key('review-submit')));
        await _settle(tester);
        expect(kit.api.lastReviewRating, 4);
        expect(kit.api.lastReviewComment, 'Arrived on time');
        expect(find.byKey(const Key('review-comment')), findsOneWidget);
        expect(find.text('Arrived on time'), findsOneWidget);
        expect(find.byKey(const Key('review-submit')), findsNothing);
      },
    );

    testWidgets('the Send button waits for at least one star', (tester) async {
      final kit = await screen(tester, (_) {});
      await tester.ensureVisible(find.byKey(const Key('review-submit')));
      await tester.tap(
        find.byKey(const Key('review-submit')),
        warnIfMissed: false,
      );
      await _settle(tester);
      expect(kit.api.calls, isNot(contains('submitReview')));
    });

    testWidgets('a review written earlier is shown, not asked for again', (
      tester,
    ) async {
      await screen(
        tester,
        (api) => api.myReviews['b-1'] = const MyReview(
          id: 'r',
          rating: 5,
          comment: 'Great work',
          status: 'PUBLISHED',
        ),
      );
      expect(find.text('Your review'), findsOneWidget);
      expect(find.text('Great work'), findsOneWidget);
      expect(find.byKey(const Key('review-submit')), findsNothing);
    });

    testWidgets('a failed send says so and keeps the form', (tester) async {
      await screen(
        tester,
        (api) => api.submitReviewResult = const ApiException(
          status: 503,
          code: 'UNAVAILABLE',
        ),
      );
      await tester.ensureVisible(find.byKey(const Key('star-5')));
      await tester.tap(find.byKey(const Key('star-5')));
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('review-submit')));
      await tester.tap(find.byKey(const Key('review-submit')));
      await _settle(tester);
      expect(find.byKey(const Key('review-failed')), findsOneWidget);
      expect(find.byKey(const Key('review-submit')), findsOneWidget);
    });

    testWidgets('nothing to review before the work is done', (tester) async {
      final (kit, _) = await _open(
        tester,
        const BookingDetailScreen(bookingId: 'b-1'),
        arrange: (api) => api.detailStore['b-1'] = BookingDetail(
          id: 'b-1',
          reference: 'BK-1',
          status: 'CONFIRMED',
          serviceNameEn: 'AC repair',
          serviceNameAr: 'إصلاح',
          location: const BookingLocation(
            cityId: 'c',
            addressLine: 'King Fahd Rd',
          ),
          isUrgent: false,
          problemDescription: 'x',
          money: const CustomerMoney(
            currency: 'SAR',
            serviceHalalas: 20000,
            vatHalalas: 3000,
            totalHalalas: 23000,
            vatRateBps: 1500,
          ),
          worker: const AssignedWorker(workerId: 'w', fullName: 'Faisal'),
          acceptedQuoteId: 'q',
        ),
      );
      expect(find.byKey(const Key('review-card')), findsNothing);
      expect(kit.api.calls, isNot(contains('myReview')));
    });
  });

  group('searching the services', () {
    testWidgets(
      'finds a service by a word in its description as well as its name',
      (tester) async {
        phoneSize(tester, height: 1800);
        final kit = TestHsClient();
        await signIn(kit);
        final services = makeServices(kit);
        addTearDown(() {
          services.catalog.dispose();
          services.submitter.dispose();
          services.bookings.dispose();
          services.notifications.dispose();
          services.offers.dispose();
          kit.client.auth.dispose();
        });
        await services.catalog.load();
        final first = services.catalog.services.first;
        await tester.pumpWidget(
          harness(
            kit: kit,
            services: services,
            state: AppState(),
            home: const ServicesScreen(),
          ),
        );
        await _settle(tester);
        final word = first.description.en
            .split(' ')
            .firstWhere((w) => w.length > 4, orElse: () => '');
        if (word.isNotEmpty) {
          await tester.enterText(find.byType(TextField), word);
          await _settle(tester);
          expect(find.text(first.name.en), findsWidgets);
        }
        await tester.enterText(
          find.byType(TextField),
          'zzzzzzzz-no-such-service',
        );
        await _settle(tester);
        expect(find.text(first.name.en), findsNothing);
      },
    );
  });
}
