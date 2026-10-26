import 'package:customer_app/app/app.dart';
import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/features/bookings/logic/worker_position_controller.dart';
import 'package:customer_app/features/bookings/screens/booking_detail_screen.dart';
import 'package:customer_app/features/messages/screens/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

import 'support/booking_harness.dart';

/// The customer's side of the live booking: where the professional is on the map, a booking that follows its status by itself, and what a
/// push about the booking does. The Google map is a platform view, so tests replace it with a plain widget that shows the coordinates.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

BookingDetail _booking({
  String status = 'CONFIRMED',
  bool exactPoint = true,
  String? method = 'CASH',
}) => BookingDetail(
  id: 'b-1',
  reference: 'HS-1',
  status: status,
  serviceNameEn: 'AC repair',
  serviceNameAr: 'إصلاح',
  location: BookingLocation(
    cityId: 'c',
    addressLine: 'King Fahd Rd',
    latitude: exactPoint ? 24.7200 : null,
    longitude: exactPoint ? 46.6800 : null,
  ),
  isUrgent: false,
  problemDescription: 'Weak cooling',
  money: const CustomerMoney(
    currency: 'SAR',
    serviceHalalas: 25000,
    vatHalalas: 3750,
    totalHalalas: 28750,
    vatRateBps: 1500,
  ),
  worker: const AssignedWorker(
    workerId: 'w',
    fullName: 'Faisal',
    phone: '+966500000001',
  ),
  acceptedQuoteId: 'q',
  paymentMethod: method,
);

Widget _fakeMap(LatLng worker, LatLng? destination) => Container(
  key: Key('fake-map-${worker.latitude},${worker.longitude}'),
  color: const Color(0xFFE4ECE9),
  child: Text(
    'to:${destination?.latitude}',
    key: const Key('fake-map-destination'),
  ),
);

void main() {
  group('the position controller', () {
    late TestHsClient kit;
    late DateTime now;

    Future<WorkerPositionController> make({
      Duration interval = Duration.zero,
    }) async {
      final k = kit = TestHsClient();
      await signIn(k);
      now = DateTime.utc(2026, 11, 1, 10);
      final c = WorkerPositionController(
        api: kit.api,
        auth: kit.client.auth,
        bookingId: 'b-1',
        interval: interval,
        clock: () => now,
      );
      addTearDown(() {
        c.dispose();
        k.client.auth.dispose();
      });
      return c;
    }

    test(
      'before the first answer nothing is loaded; "not open yet" and "no recent position" are told apart',
      () async {
        final c = await make();
        expect(c.loaded, isFalse);
        await c.refresh();
        expect(c.loaded, isTrue);
        expect(c.position!.available, isFalse);
        expect(c.position!.reason, LiveLocationReason.notActive);

        kit.api.positions['b-1'] = const LiveLocation.unavailable(
          LiveLocationReason.noRecentPosition,
        );
        await c.refresh();
        expect(c.position!.reason, LiveLocationReason.noRecentPosition);
        expect(c.age, isNull);
      },
    );

    test(
      'a shared position is shown with its age counted from the server\'s own figure and our clock since',
      () async {
        final c = await make();
        kit.api.positions['b-1'] = const LiveLocation.at(
          latitude: 24.7136,
          longitude: 46.6753,
          ageSeconds: 4,
        );
        await c.refresh();
        expect(c.position!.latitude, 24.7136);
        expect(c.age, const Duration(seconds: 4));
        now = now.add(const Duration(seconds: 30));
        expect(c.age, const Duration(seconds: 34));
      },
    );

    test(
      'a failed refresh keeps the last position and records the error; it never invents or clears one',
      () async {
        final c = await make();
        kit.api.positions['b-1'] = const LiveLocation.at(
          latitude: 24.7,
          longitude: 46.6,
          ageSeconds: 0,
        );
        await c.refresh();
        kit.api.positionResult = const ApiException(status: 0, code: 'NETWORK');
        await c.refresh();
        expect(c.error, isNotNull);
        expect(c.position!.latitude, 24.7);
      },
    );

    test(
      'coordinates the server sends that cannot be real are "no position", never a pin at 0,0',
      () {
        for (final bad in [
          {'latitude': 0.0, 'longitude': 0.0},
          {'latitude': 95.0, 'longitude': 46.0},
          {'latitude': 24.0, 'longitude': 200.0},
          {'latitude': null, 'longitude': 46.0},
        ]) {
          final p = LiveLocation.fromJson({
            'available': true,
            'location': bad,
            'ageSeconds': 1,
          });
          expect(p.available, isFalse, reason: '$bad');
        }
      },
    );

    test(
      'it polls while alive and stops when disposed; overlapping asks share one request',
      () async {
        final c = await make(interval: const Duration(milliseconds: 20));
        c.start();
        await Future<void>.delayed(const Duration(milliseconds: 120));
        final calls = kit.api.calls.where((x) => x == 'workerPosition').length;
        expect(calls, greaterThan(2));
        c.dispose();
        await Future<void>.delayed(const Duration(milliseconds: 80));
        expect(kit.api.calls.where((x) => x == 'workerPosition').length, calls);

        final d = await make();
        await Future.wait([d.refresh(), d.refresh(), d.refresh()]);
        expect(kit.api.calls.where((x) => x == 'workerPosition'), hasLength(1));
      },
    );
  });

  if (kDemoData) return;
  setUpAll(loadAppFonts);

  group('the booking screen follows the professional and the status', () {
    Future<TestHsClient> open(
      WidgetTester tester,
      BookingDetail booking, {
      void Function(FakeApi)? arrange,
      bool maps = true,
      bool arabic = false,
    }) async {
      phoneSize(tester, height: 1800);
      final kit = TestHsClient();
      await signIn(kit);
      kit.api.detailStore['b-1'] = booking;
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
          home: BookingDetailScreen(
            bookingId: 'b-1',
            mapBuilder: _fakeMap,
            mapsEnabled: maps,
            pollInterval: const Duration(seconds: 6),
          ),
        ),
      );
      await _settle(tester);
      return kit;
    }

    testWidgets(
      'a paid booking with a shared position shows the map at the professional, with the booking\'s address as the destination',
      (tester) async {
        await open(
          tester,
          _booking(),
          arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
            latitude: 24.7136,
            longitude: 46.6753,
            ageSeconds: 3,
          ),
        );
        expect(find.byKey(const Key('live-map')), findsOneWidget);
        expect(
          find.byKey(const Key('fake-map-24.7136,46.6753')),
          findsOneWidget,
        );
        expect(find.text('to:24.72'), findsOneWidget);
        expect(find.text('Updated just now'), findsOneWidget);
      },
    );

    testWidgets(
      'the pin moves as the professional moves (a new position is picked up while the screen is open)',
      (tester) async {
        final kit = await open(
          tester,
          _booking(),
          arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
            latitude: 24.7136,
            longitude: 46.6753,
            ageSeconds: 0,
          ),
        );
        expect(
          find.byKey(const Key('fake-map-24.7136,46.6753')),
          findsOneWidget,
        );

        kit.api.positions['b-1'] = const LiveLocation.at(
          latitude: 24.7160,
          longitude: 46.6780,
          ageSeconds: 0,
        );
        await tester.pump(const Duration(seconds: 6));
        await _settle(tester);
        expect(find.byKey(const Key('fake-map-24.716,46.678')), findsOneWidget);
        expect(find.byKey(const Key('fake-map-24.7136,46.6753')), findsNothing);
      },
    );

    testWidgets(
      'a position that stops arriving is marked as last seen, not shown as live',
      (tester) async {
        final kit = await open(
          tester,
          _booking(),
          arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
            latitude: 24.7136,
            longitude: 46.6753,
            ageSeconds: 0,
          ),
        );
        kit.api.positionResult = const ApiException(status: 0, code: 'NETWORK');
        await tester.pump(const Duration(seconds: 6));
        await _settle(tester);
        expect(
          find.byKey(const Key('fake-map-24.7136,46.6753')),
          findsOneWidget,
          reason: 'the last known position stays',
        );
        expect(find.textContaining('Last seen'), findsOneWidget);
      },
    );

    testWidgets(
      'no position yet: says what it is waiting for, and draws nothing',
      (tester) async {
        await open(
          tester,
          _booking(),
          arrange: (api) =>
              api.positions['b-1'] = const LiveLocation.unavailable(
                LiveLocationReason.noRecentPosition,
              ),
        );
        expect(
          find.text('Waiting for your professional to share their location…'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('fake-map-destination')), findsNothing);
      },
    );

    testWidgets(
      'sharing not open yet: says the location appears shortly before the visit',
      (tester) async {
        await open(tester, _booking());
        expect(
          find.text('The live location appears shortly before the visit.'),
          findsOneWidget,
        );
      },
    );

    testWidgets('a failure before any position: says so', (tester) async {
      await open(
        tester,
        _booking(),
        arrange: (api) => api.positionResult = const ApiException(
          status: 503,
          code: 'UNAVAILABLE',
        ),
      );
      expect(find.text('Could not update the location.'), findsOneWidget);
    });

    testWidgets(
      'without a Maps key the position is not drawn, and the screen says why',
      (tester) async {
        await open(
          tester,
          _booking(),
          maps: false,
          arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
            latitude: 24.7136,
            longitude: 46.6753,
            ageSeconds: 0,
          ),
        );
        expect(
          find.text('The map is not set up on this phone.'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('fake-map-24.7136,46.6753')), findsNothing);
      },
    );

    testWidgets('no map before payment or after the job', (tester) async {
      for (final status in [
        'OPEN',
        'PAYMENT_PENDING',
        'COMPLETED',
        'CANCELLED',
      ]) {
        await open(tester, _booking(status: status, method: null));
        expect(find.byKey(const Key('live-map')), findsNothing, reason: status);
        await tester.pumpWidget(const SizedBox());
      }
      await open(tester, _booking(status: 'IN_PROGRESS'));
      expect(find.byKey(const Key('live-map')), findsOneWidget);
    });

    testWidgets(
      'the status changes by itself: CONFIRMED to IN_PROGRESS to COMPLETED, with the map going away at the end',
      (tester) async {
        final kit = await open(tester, _booking());
        expect(find.byKey(const Key('detail-status')), findsOneWidget);
        expect(find.text('Confirmed'), findsOneWidget);

        kit.api.detailStore['b-1'] = _booking(status: 'IN_PROGRESS');
        await tester.pump(const Duration(seconds: 7));
        await _settle(tester);
        expect(find.text('In progress'), findsOneWidget);

        kit.api.detailStore['b-1'] = _booking(status: 'COMPLETED');
        await tester.pump(const Duration(seconds: 7));
        await _settle(tester);
        expect(find.text('Completed'), findsOneWidget);
        expect(find.byKey(const Key('live-map')), findsNothing);
      },
    );

    testWidgets('a new quote shows up by itself on an open request', (
      tester,
    ) async {
      final kit = await open(tester, _booking(status: 'OPEN', method: null));
      expect(find.byKey(const Key('no-quotes')), findsOneWidget);
      kit.api.customerQuoteList.add(
        CustomerQuote(
          id: 'q-9',
          bookingId: 'b-1',
          status: 'SUBMITTED',
          version: 1,
          money: const CustomerMoney(
            currency: 'SAR',
            serviceHalalas: 25000,
            vatHalalas: 3750,
            totalHalalas: 28750,
            vatRateBps: 1500,
          ),
          worker: const QuoteWorker(workerId: 'w', fullName: 'Faisal'),
          isExpired: false,
        ),
      );
      await tester.pump(const Duration(seconds: 7));
      await _settle(tester);
      expect(find.byKey(const Key('accept-q-9')), findsOneWidget);
    });

    testWidgets('renders in Arabic', (tester) async {
      await open(
        tester,
        _booking(),
        arabic: true,
        arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
          latitude: 24.7136,
          longitude: 46.6753,
          ageSeconds: 0,
        ),
      );
      expect(find.text('موقع الفني'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('a push about a booking', () {
    Future<TestHsClient> launch(
      WidgetTester tester, {
      void Function(FakeApi)? arrange,
    }) async {
      phoneSize(tester, height: 1200);
      final kit = TestHsClient();
      await signIn(kit);
      kit.api.detailStore['b-1'] = _booking(status: 'OPEN', method: null);
      arrange?.call(kit.api);
      addTearDown(kit.client.auth.dispose);
      await tester.pumpWidget(App(client: kit.client));
      await tester.pump(
        const Duration(seconds: 4),
      ); // the splash screen hands over to the home screen first
      await _settle(tester);
      return kit;
    }

    PushEvent event(String type) => PushEvent(
      notificationId: '$type-b-1',
      type: type,
      resourceType: 'booking',
      resourceId: 'b-1',
      title: 'Title $type',
      body: 'Body',
    );

    testWidgets(
      'while the app is open: the bookings refresh and the customer is told, with a way in',
      (tester) async {
        final kit = await launch(tester);
        final before = kit.api.calls.where((c) => c == 'myBookings').length;
        kit.push.foregroundEvents.add(event('quote.received'));
        await _settle(tester);
        expect(
          kit.api.calls.where((c) => c == 'myBookings').length,
          greaterThan(before),
        );
        expect(find.byKey(const Key('push-snackbar')), findsOneWidget);
        expect(find.textContaining('Title quote.received'), findsOneWidget);

        await tester.tap(find.byType(SnackBarAction));
        await _settle(tester);
        expect(find.byType(BookingDetailScreen), findsOneWidget);
      },
    );

    testWidgets(
      'tapping a step of the booking (quote, payment, work started, cancelled) opens that booking',
      (tester) async {
        final kit = await launch(tester);
        for (final type in [
          'quote.received',
          'payment.confirmed',
          'work.started',
          'work.completed',
          'booking.cancelled',
        ]) {
          kit.push.openedEvents.add(event(type));
          await _settle(tester);
          expect(
            find.byType(BookingDetailScreen),
            findsOneWidget,
            reason: type,
          );
          Navigator.of(tester.element(find.byType(BookingDetailScreen))).pop();
          await _settle(tester);
        }
      },
    );

    testWidgets(
      'tapping a chat message opens that booking\'s chat with the professional',
      (tester) async {
        final kit = await launch(
          tester,
          arrange: (api) {
            api.detailStore['b-1'] = _booking();
            api.chatBookings.add('b-1');
            api.chatPeerMessage('b-1', 'I am on my way');
          },
        );
        kit.push.openedEvents.add(event('chat.message'));
        await _settle(tester);
        expect(find.byType(ChatScreen), findsOneWidget);
        expect(find.text('I am on my way'), findsOneWidget);
        expect(find.text('Faisal'), findsWidgets);
      },
    );

    testWidgets('a push that is not about a booking changes nothing here', (
      tester,
    ) async {
      final kit = await launch(tester);
      kit.push.foregroundEvents.add(
        const PushEvent(
          notificationId: 'x',
          type: 'support.reply',
          title: 'Support replied',
          body: 'b',
        ),
      );
      kit.push.openedEvents.add(
        const PushEvent(notificationId: 'y', type: 'support.reply'),
      );
      await _settle(tester);
      expect(find.byKey(const Key('push-snackbar')), findsNothing);
      expect(find.byType(BookingDetailScreen), findsNothing);
    });

    testWidgets('after sign-out a push does nothing', (tester) async {
      final kit = await launch(tester);
      await kit.client.auth.signOut();
      await _settle(tester);
      kit.push.openedEvents.add(event('quote.received'));
      await _settle(tester);
      expect(find.byType(BookingDetailScreen), findsNothing);
    });
  });
}
