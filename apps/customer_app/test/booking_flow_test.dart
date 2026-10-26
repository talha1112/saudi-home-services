import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/app/booking_scope.dart';
import 'package:customer_app/app/localization/app_strings.dart';
import 'package:customer_app/shared/models/service.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/features/catalog/catalog_controller.dart';
import 'package:customer_app/features/booking/screens/booking_screen.dart';
import 'package:customer_app/features/booking/screens/booking_sent_screen.dart';
import 'package:customer_app/features/home/screens/main_shell.dart';
import 'package:customer_app/features/location/models/picked_location.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

import 'support/booking_harness.dart';

/// The real customer booking flow through the real screens: catalog -> service -> city and place -> time -> description -> request sent
/// to the (fake) backend -> confirmation built from its answer -> the booking in the customer's list.
/// Prototype fixtures are off here (DEMO_DATA is not set), exactly as in a release build. The map picker is a platform view and has its
/// own tests; here the confirmed place is put into the draft the way the picker's result is.
const _pin = PickedLocation(
  latitude: 24.7136,
  longitude: 46.6753,
  address: 'King Fahd Rd, Al Olaya, Riyadh 12211',
  district: 'Al Olaya',
  building: '12',
  unit: '4',
);

const _description = 'Two split units, weak cooling and water dripping';

class _Ctx {
  _Ctx(this.kit, this.services, this.state);
  final TestHsClient kit;
  final BookingServices services;
  final AppState state;
  FakeApi get api => kit.api;
}

ApiException _api(int status, String code, {String? message}) =>
    ApiException(status: status, code: code, message: message);

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
  bool signedIn = true,
  bool loadCatalog = true,
  void Function(FakeApi)? arrange,
}) async {
  phoneSize(tester);
  final kit = TestHsClient();
  if (signedIn) await signIn(kit);
  arrange?.call(kit.api);
  final services = makeServices(kit);
  final state = AppState()..setArabic(arabic);
  addTearDown(() {
    services.catalog.dispose();
    services.submitter.dispose();
    services.bookings.dispose();
    kit.client.auth.dispose();
  });
  if (loadCatalog) await services.catalog.load();
  await tester.pumpWidget(
    harness(
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

/// A draft as if the customer had chosen the AC service and confirmed [_pin] on the map.
Future<_Ctx> _bootBooking(
  WidgetTester tester, {
  int step = 1,
  bool arabic = false,
  bool signedIn = true,
  bool withLocation = true,
  void Function(FakeApi)? arrange,
}) async {
  final ctx = await _boot(
    tester,
    home: BookingScreen(initialStep: step),
    arabic: arabic,
    signedIn: signedIn,
    arrange: arrange,
  );
  ctx.state.startBooking(
    ctx.services.catalog.serviceById('svc-ac') ??
        const Service(
          id: 'svc-ac',
          category: 'cat-1',
          name: Bi('AC repair', 'إصلاح المكيفات'),
          description: Bi('', ''),
          icon: 'wrench',
        ),
  );
  if (withLocation) ctx.state.update(() => ctx.state.pickedLocation = _pin);
  await tester.pump();
  return ctx;
}

Future<void> _tapKey(WidgetTester tester, String key) async {
  await tester.tap(find.byKey(Key(key)));
  await _settle(tester);
}

Future<void> _tapText(WidgetTester tester, String text) async {
  await tester.tap(find.text(text));
  await _settle(tester);
}

AppButtonProbe _cta(WidgetTester tester) => AppButtonProbe(tester);

/// Reads the main button without depending on its widget class.
class AppButtonProbe {
  AppButtonProbe(this.tester);
  final WidgetTester tester;

  bool get exists => find.byKey(const Key('booking-cta')).evaluate().isNotEmpty;

  /// The button is drawn in the muted colour when disabled; ask the widget instead of the pixels.
  bool get enabled {
    final w = tester.widget(find.byKey(const Key('booking-cta')));
    return (w as dynamic).enabled as bool;
  }

  String get label =>
      (tester.widget(find.byKey(const Key('booking-cta'))) as dynamic).label
          as String;
}

Future<void> _fillAllAndOpenLastStep(WidgetTester tester, _Ctx ctx) async {
  await _tapKey(tester, 'city-city-ruh');
  await _tapText(tester, 'Continue');
  await _tapKey(tester, 'day-1');
  await _tapKey(tester, 'slot-4');
  await _tapText(tester, 'Continue');
  await tester.enterText(find.byType(TextField), _description);
  await _settle(tester);
}

void main() {
  if (kDemoData) {
    test(
      'these tests describe the release behaviour: run them without DEMO_DATA',
      () {},
      skip: 'DEMO_DATA is on',
    );
    return;
  }

  setUpAll(loadAppFonts);

  group('the whole path, through the real screens', () {
    testWidgets('home -> service -> booking -> request sent -> my bookings', (
      tester,
    ) async {
      final ctx = await _boot(tester, root: '/home');

      // Home offers the backend's services, not the prototype's.
      expect(find.text('AC repair'), findsOneWidget);
      expect(find.text('AC Deep Cleaning'), findsNothing);
      await _tapText(tester, 'AC repair');
      expect(find.text('Book service'), findsOneWidget);
      expect(
        find.textContaining('SAR'),
        findsNothing,
        reason: 'the catalog has no price, so none is shown',
      );

      await _tapText(tester, 'Book service');
      expect(find.text('Step 1 of 3'), findsOneWidget);
      expect(ctx.state.serviceId, 'svc-ac');
      ctx.state.update(() => ctx.state.pickedLocation = _pin);
      await tester.pump();

      await _fillAllAndOpenLastStep(tester, ctx);
      expect(find.text('Step 3 of 3'), findsOneWidget);
      await _tapKey(tester, 'booking-cta');

      // The backend received exactly one request, with the real ids and the typed place.
      final sent = ctx.api.createdBookings.single;
      expect(sent.serviceId, 'svc-ac');
      expect(sent.cityId, 'city-ruh');
      expect(sent.problemDescription, _description);
      expect(sent.locationFields, _pin.toBookingFields());
      expect(sent.isUrgent, isFalse);
      expect(sent.preferredStartAt.isAfter(DateTime.now().toUtc()), isTrue);
      expect(
        sent.preferredEndAt.difference(sent.preferredStartAt),
        const Duration(hours: 2),
      );

      // The confirmation is built from the backend's answer.
      expect(find.byType(BookingSentScreen), findsOneWidget);
      expect(find.text('Request sent'), findsOneWidget);
      expect(find.text('HS-1'), findsOneWidget);
      expect(find.text('Waiting for quotes'), findsOneWidget);
      expect(
        find.textContaining('paying anything'),
        findsOneWidget,
        reason: 'it says plainly that nothing was charged',
      );

      // ... and it leads to the customer's bookings, where the new request is.
      await _tapKey(tester, 'view-bookings');
      expect(find.byType(BookingSentScreen), findsNothing);
      expect(ctx.state.tab, 1);
      expect(find.byKey(const Key('booking-booking-1')), findsOneWidget);
      expect(find.text('AC repair'), findsWidgets);
      expect(find.text('Waiting for quotes'), findsWidgets);
    });

    testWidgets('as soon as possible is sent as urgent', (tester) async {
      final ctx = await _bootBooking(tester);
      await _tapKey(tester, 'city-city-ruh');
      await _tapText(tester, 'Continue');
      expect(_cta(tester).enabled, isFalse, reason: 'no time chosen yet');
      await _tapKey(tester, 'asap');
      expect(_cta(tester).enabled, isTrue);
      await _tapText(tester, 'Continue');
      await tester.enterText(find.byType(TextField), _description);
      await _settle(tester);
      await _tapKey(tester, 'booking-cta');

      expect(ctx.api.createdBookings.single.isUrgent, isTrue);
      expect(find.byType(BookingSentScreen), findsOneWidget);
    });
  });

  group('validation before anything is sent', () {
    testWidgets('step 1 needs a city and a place', (tester) async {
      final ctx = await _bootBooking(tester, withLocation: false);
      expect(find.text('Riyadh'), findsOneWidget);
      expect(find.text('Jeddah'), findsOneWidget);
      expect(_cta(tester).enabled, isFalse);

      await _tapKey(tester, 'city-city-ruh');
      expect(
        _cta(tester).enabled,
        isFalse,
        reason: 'a city alone is not enough',
      );

      ctx.state.update(() => ctx.state.pickedLocation = _pin);
      await tester.pump();
      expect(_cta(tester).enabled, isTrue);
      expect(ctx.api.createdBookings, isEmpty);
    });

    testWidgets(
      'a place is never defaulted: with none chosen the draft is incomplete',
      (tester) async {
        final ctx = await _bootBooking(tester, withLocation: false);
        ctx.state.update(() => ctx.state.cityId = 'city-ruh');
        expect(ctx.state.pickedLocation, isNull);
        expect(ctx.state.draft.missing(), contains('location'));
      },
    );

    testWidgets('the description needs 10 characters, and says so', (
      tester,
    ) async {
      final ctx = await _bootBooking(tester, step: 3);
      ctx.state.update(() {
        ctx.state.cityId = 'city-ruh';
        ctx.state.asap = true;
      });
      await tester.pump();

      expect(find.textContaining('at least 10 characters'), findsOneWidget);
      expect(_cta(tester).enabled, isFalse);
      await tester.enterText(find.byType(TextField), 'too short');
      await tester.pump();
      expect(_cta(tester).enabled, isFalse);
      await tester.enterText(find.byType(TextField), '1234567890');
      await tester.pump();
      expect(_cta(tester).enabled, isTrue);
      expect(find.byKey(const Key('description-hint')), findsOneWidget);
      expect(ctx.api.createdBookings, isEmpty);
    });

    testWidgets(
      'photos are not offered: POST /bookings has no place for them',
      (tester) async {
        await _bootBooking(tester, step: 3);
        expect(find.text('Add photos'), findsNothing);
      },
    );
  });

  group('errors are shown and nothing is lost', () {
    testWidgets(
      'the backend refuses (open-request limit): reason shown, still on the page, can send again',
      (tester) async {
        final ctx = await _bootBooking(
          tester,
          arrange: (api) =>
              api.createBookingResult = _api(409, 'BOOKING_LIMIT'),
        );
        await _fillAllAndOpenLastStep(tester, ctx);
        await _tapKey(tester, 'booking-cta');

        expect(find.byKey(const Key('submit-error')), findsOneWidget);
        expect(
          find.textContaining('maximum number of open requests'),
          findsOneWidget,
        );
        expect(find.byType(BookingSentScreen), findsNothing);
        expect(_cta(tester).enabled, isTrue);
        expect(
          ctx.state.description,
          _description,
          reason: 'what was typed is kept',
        );

        ctx.api.createBookingResult = null;
        await _tapKey(tester, 'booking-cta');
        expect(find.byType(BookingSentScreen), findsOneWidget);
        expect(ctx.api.bookingList, hasLength(1));
      },
    );

    testWidgets(
      'no connection: says so, keeps everything, and the retry creates exactly one booking',
      (tester) async {
        final ctx = await _bootBooking(
          tester,
          arrange: (api) => api.failAfterCreating = _api(0, 'NETWORK'),
        );
        await _fillAllAndOpenLastStep(tester, ctx);
        await _tapKey(tester, 'booking-cta');

        expect(find.textContaining('No connection'), findsOneWidget);
        expect(find.byType(BookingSentScreen), findsNothing);
        expect(
          ctx.api.bookingList,
          hasLength(1),
          reason: 'the server had created it before the answer was lost',
        );

        await _tapKey(tester, 'booking-cta');
        expect(find.byType(BookingSentScreen), findsOneWidget);
        expect(find.text('HS-1'), findsOneWidget);
        expect(
          ctx.api.createdBookings,
          hasLength(1),
          reason: 'the retry adopted the booking instead of sending again',
        );
        expect(ctx.api.bookingList, hasLength(1));
      },
    );

    testWidgets(
      'the backend rejects the schedule: its reason is shown and the time step opens',
      (tester) async {
        final ctx = await _bootBooking(
          tester,
          arrange: (api) => api.createBookingResult = _api(
            400,
            'INVALID_SCHEDULE',
            message: 'Start time must be at least 45 minutes ahead',
          ),
        );
        await _fillAllAndOpenLastStep(tester, ctx);
        await _tapKey(tester, 'booking-cta');

        expect(find.text('Step 2 of 3'), findsOneWidget);
        expect(find.byKey(const Key('slot-0')), findsOneWidget);
        ctx.state.update(
          () {},
        ); // the banner is part of the last step; the reason is held by the submitter
        expect(
          ctx.services.submitter.failure!.message,
          'Start time must be at least 45 minutes ahead',
        );
      },
    );

    testWidgets(
      'signed out: nothing is sent and the customer is told to sign in',
      (tester) async {
        final ctx = await _bootBooking(tester, signedIn: false);
        await _fillAllAndOpenLastStep(tester, ctx);
        await _tapKey(tester, 'booking-cta');

        expect(find.textContaining('sign in again'), findsOneWidget);
        expect(ctx.api.createdBookings, isEmpty);
        expect(find.byType(BookingSentScreen), findsNothing);
      },
    );
  });

  group('double taps', () {
    testWidgets('tapping the button repeatedly sends one request', (
      tester,
    ) async {
      final ctx = await _bootBooking(tester);
      await _fillAllAndOpenLastStep(tester, ctx);

      // three taps before the screen gets a chance to redraw
      for (var i = 0; i < 3; i++) {
        await tester.tap(
          find.byKey(const Key('booking-cta')),
          warnIfMissed: false,
        );
      }
      await _settle(tester);

      expect(ctx.api.createdBookings, hasLength(1));
      expect(ctx.api.bookingList, hasLength(1));
      expect(find.byType(BookingSentScreen), findsOneWidget);
    });
  });

  group('services and cities come from the backend', () {
    testWidgets(
      'services screen lists catalog services and hides what the catalog does not have',
      (tester) async {
        await _boot(tester, root: '/home');
        await _tapText(tester, 'See all');
        expect(find.text('AC repair'), findsOneWidget);
        expect(find.text('Plumbing'), findsWidgets);
        expect(find.text('AC Deep Cleaning'), findsNothing);
        expect(find.textContaining('SAR'), findsNothing);
        expect(
          find.text('Available today'),
          findsNothing,
          reason: 'no availability data exists, so no such filter',
        );
      },
    );

    testWidgets('cities that fail to load can be retried', (tester) async {
      final ctx = await _bootBooking(
        tester,
        arrange: (api) => api.failures['catalog'] = _api(0, 'NETWORK'),
      );
      // the catalog failed before the booking started, so there was no service: load it for real now
      expect(ctx.services.catalog.status, CatalogStatus.failed);
      expect(find.text('Could not load the cities.'), findsOneWidget);
      await _tapKey(tester, 'retry-cities');
      expect(find.text('Riyadh'), findsOneWidget);
      expect(find.text('Jeddah'), findsOneWidget);
    });

    testWidgets('no cities yet is stated, not an empty gap', (tester) async {
      await _bootBooking(
        tester,
        arrange: (api) => api.catalogResult = Catalog(
          categories: api.catalogResult.categories,
          cities: const [],
        ),
      );
      expect(find.text('No cities are available yet.'), findsOneWidget);
      expect(_cta(tester).enabled, isFalse);
    });

    testWidgets('home shows a retry when the catalog cannot be loaded', (
      tester,
    ) async {
      final ctx = await _boot(
        tester,
        arrange: (api) => api.failures['catalog'] = _api(0, 'NETWORK'),
      );
      expect(find.text('Could not load the services.'), findsOneWidget);
      await _tapKey(tester, 'retry-catalog');
      expect(ctx.services.catalog.status, CatalogStatus.ready);
      expect(find.text('AC repair'), findsOneWidget);
    });

    testWidgets('a service that is not in the catalog cannot start a booking', (
      tester,
    ) async {
      final ctx = await _boot(tester, root: '/home');
      final context = tester.element(find.byType(MainShell));
      expect(resolveService(context, 'acdeep'), isNull);
      expect(resolveService(context, 'svc-ac')!.id, 'svc-ac');
      expect(ctx.state.serviceId, isNull);
    });
  });

  group('the bookings tab', () {
    testWidgets('empty, failed with retry, and a list', (tester) async {
      final ctx = await _boot(
        tester,
        arrange: (api) => api.myBookingsResult = _api(0, 'NETWORK'),
      );
      ctx.state.showTab(1, bookings: 0);
      await _settle(tester);
      expect(find.byKey(const Key('bookings-failed')), findsOneWidget);

      ctx.api.myBookingsResult = null;
      await _tapKey(tester, 'bookings-retry');
      expect(find.text('No bookings yet'), findsOneWidget);

      await ctx.api.createBooking(
        'token',
        CreateBookingRequest(
          serviceId: 'svc-ac',
          cityId: 'city-ruh',
          problemDescription: _description,
          preferredStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
          preferredEndAt: DateTime.now().toUtc().add(
            const Duration(days: 1, hours: 2),
          ),
          isUrgent: false,
          locationFields: _pin.toBookingFields(),
        ),
      );
      await ctx.services.bookings.load();
      await _settle(tester);
      expect(find.byKey(const Key('booking-booking-1')), findsOneWidget);
      expect(find.text('HS-1'), findsOneWidget);
    });

    testWidgets('no prototype bookings, quotes or payments appear', (
      tester,
    ) async {
      final ctx = await _boot(tester);
      ctx.state.showTab(1, bookings: 1);
      await _settle(tester);
      expect(find.text('Track your professional'), findsNothing);
      expect(find.textContaining('Faisal'), findsNothing);
      expect(find.textContaining('SAR'), findsNothing);
    });
  });

  group('the confirmation', () {
    BookingView view({
      String status = 'OPEN',
      String reference = 'HS-20261101-AB12',
    }) => BookingView(
      id: 'b-1',
      reference: reference,
      status: status,
      location: const BookingLocation(cityId: 'city-ruh'),
      preferredStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
      preferredEndAt: DateTime.now().toUtc().add(
        const Duration(days: 1, hours: 2),
      ),
    );

    testWidgets('shows the reference and status the backend returned', (
      tester,
    ) async {
      await _boot(tester, home: BookingSentScreen(booking: view()));
      expect(find.text('HS-20261101-AB12'), findsOneWidget);
      expect(find.text('Waiting for quotes'), findsOneWidget);
      expect(find.byKey(const Key('view-bookings')), findsOneWidget);
      expect(find.byKey(const Key('back-home')), findsOneWidget);
    });

    testWidgets('an unknown status is shown as the backend sent it', (
      tester,
    ) async {
      await _boot(
        tester,
        home: BookingSentScreen(booking: view(status: 'ON_HOLD')),
      );
      expect(find.text('ON_HOLD'), findsOneWidget);
    });

    testWidgets('renders in Arabic', (tester) async {
      await _boot(
        tester,
        home: BookingSentScreen(booking: view()),
        arabic: true,
      );
      expect(find.text('تم إرسال الطلب'), findsOneWidget);
      expect(find.text('بانتظار عروض الأسعار'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('the booking screens render in both languages', () {
    for (final arabic in [false, true]) {
      for (final step in [1, 2, 3]) {
        testWidgets('step $step (${arabic ? 'ar' : 'en'})', (tester) async {
          await _bootBooking(tester, step: step, arabic: arabic);
          expect(tester.takeException(), isNull);
          expect(find.byKey(const Key('booking-cta')), findsOneWidget);
        });
      }
    }
  });
}
