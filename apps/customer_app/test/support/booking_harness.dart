import 'package:customer_app/app/app_scope.dart';
import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/app/auth_scope.dart';
import 'package:customer_app/app/booking_scope.dart';
import 'package:customer_app/app/theme/app_theme.dart';
import 'package:customer_app/features/booking/logic/booking_submitter.dart';
import 'package:customer_app/features/bookings/logic/booking_detail_controller.dart';
import 'package:customer_app/features/bookings/logic/worker_position_controller.dart';
import 'package:customer_app/features/bookings/my_bookings_controller.dart';
import 'package:customer_app/features/catalog/catalog_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

/// The booking controllers the way `App` builds them, on top of the shared fake backend.
BookingServices makeServices(TestHsClient kit, {DateTime Function()? clock}) =>
    BookingServices(
      catalog: CatalogController(load: kit.api.catalog),
      submitter: BookingSubmitter(
        api: kit.api,
        auth: kit.client.auth,
        clock: clock,
      ),
      bookings: MyBookingsController(api: kit.api, auth: kit.client.auth),
      detailFor: (id) => BookingDetailController(
        api: kit.api,
        auth: kit.client.auth,
        bookingId: id,
      ),
      positionFor: (id, interval) => WorkerPositionController(
        api: kit.api,
        auth: kit.client.auth,
        bookingId: id,
        interval: interval,
      ),
      notifications: NotificationsController(
        api: kit.api,
        auth: kit.client.auth,
      ),
      offers: OffersController(api: kit.api, auth: kit.client.auth),
      openFromNotification: (_) async {},
    );

/// A material app with every scope the customer screens need.
Widget harness({
  required TestHsClient kit,
  required BookingServices services,
  required AppState state,
  required Widget home,
  bool arabic = false,
  String? rootRouteName,
}) {
  return AuthScope(
    controller: kit.client.auth,
    child: BookingScope(
      services: services,
      child: AppScope(
        state: state,
        child: MaterialApp(
          // the app's tab shell is the route named '/home'; give the root that name to let "back to the shell" navigation work
          initialRoute: rootRouteName,
          onGenerateRoute: rootRouteName == null
              ? null
              : (settings) => MaterialPageRoute<void>(
                  settings: settings,
                  builder: (_) => home,
                ),
          theme: AppTheme.of(arabic: arabic),
          locale: Locale(arabic ? 'ar' : 'en'),
          supportedLocales: const [Locale('en'), Locale('ar')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: rootRouteName == null ? home : null,
        ),
      ),
    ),
  );
}

/// Signs the test customer in through the real controller (Firebase and the backend are fakes).
Future<void> signIn(TestHsClient kit) async {
  await kit.client.auth.sendCode('+966551234567');
  await kit.client.auth.submitCode('123456');
}

/// The real app fonts, so layouts match what a phone shows (the default test font is much wider).
Future<void> loadAppFonts() async {
  const families = {
    'Archivo': ['400', '500', '600', '700', '800'],
    'Tajawal': ['400', '500', '700', '800'],
  };
  for (final entry in families.entries) {
    final loader = FontLoader(entry.key);
    for (final w in entry.value) {
      loader.addFont(rootBundle.load('assets/fonts/${entry.key}-$w.ttf'));
    }
    await loader.load();
  }
}

/// Phone-sized, tall enough that lists do not need scrolling.
void phoneSize(WidgetTester tester, {double height = 1400}) {
  tester.view.physicalSize = Size(390 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}
