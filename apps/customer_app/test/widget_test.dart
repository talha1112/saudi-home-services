import 'package:customer_app/app/app.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/features/authentication/screens/login_screen.dart';
import 'package:customer_app/features/authentication/screens/otp_screen.dart';
import 'package:customer_app/features/booking/screens/booking_screen.dart';
import 'package:customer_app/features/bookings/screens/invoice_screen.dart';
import 'package:customer_app/features/home/screens/main_shell.dart';
import 'package:customer_app/features/messages/screens/chat_screen.dart';
import 'package:customer_app/features/onboarding/screens/onboarding_screen.dart';
import 'package:customer_app/features/payments/screens/confirm_screen.dart';
import 'package:customer_app/features/payments/screens/pay_screen.dart';
import 'package:customer_app/features/reviews/screens/rate_screen.dart';
import 'package:customer_app/features/services/screens/service_details_screen.dart';
import 'package:customer_app/features/services/screens/services_screen.dart';
import 'package:customer_app/features/tracking/screens/track_screen.dart';
import 'support/booking_harness.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/testing.dart';

/// Renders [screen] at phone size and fails on any layout/runtime exception.
Future<void> _render(
  WidgetTester tester,
  Widget screen, {
  required bool arabic,
  void Function(AppState)? setup,
}) async {
  tester.view.physicalSize = const Size(390 * 3, 844 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final state = AppState()..setArabic(arabic);
  setup?.call(state);
  final kit = TestHsClient();
  final services = makeServices(kit);
  addTearDown(kit.client.auth.dispose);
  await tester.pumpWidget(
    harness(
      kit: kit,
      services: services,
      state: state,
      home: screen,
      arabic: arabic,
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _loadFonts() async {
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

void main() {
  setUpAll(_loadFonts);

  final screens = <String, Widget Function()>{
    'onboarding': () => const OnboardingScreen(),
    'login': () => const LoginScreen(),
    'otp': () => const OtpScreen(),
    'home shell': () => const MainShell(),
    'services': () => const ServicesScreen(),
    'service details': () => const ServiceDetailsScreen(),
    'booking step 1': () => const BookingScreen(initialStep: 1),
    'booking step 2': () => const BookingScreen(initialStep: 2),
    'booking step 3': () => const BookingScreen(initialStep: 3),
    'booking step 4': () => const BookingScreen(initialStep: 4),
    'booking step 5': () => const BookingScreen(initialStep: 5),
    'pay': () => const PayScreen(),
    'confirm': () => const ConfirmScreen(),
    'track': () => const TrackScreen(),
    'chat': () => const ChatScreen(),
    'invoice': () => const InvoiceScreen(),
    'rate': () => const RateScreen(),
  };

  // Prototype screens (invented prices, workers, quotes, payment, tracking) exist only in demo builds:
  //   flutter test --dart-define=DEMO_DATA=true test/widget_test.dart
  const demoOnly = {
    'service details',
    'booking step 4',
    'booking step 5',
    'pay',
    'confirm',
    'track',
    'chat',
    'invoice',
    'rate',
  };

  for (final arabic in [false, true]) {
    for (final entry in screens.entries) {
      testWidgets(
        '${entry.key} renders (${arabic ? 'ar' : 'en'})',
        (tester) async {
          await _render(tester, entry.value(), arabic: arabic);
          expect(tester.takeException(), isNull);
        },
        skip: demoOnly.contains(entry.key) && !kDemoData,
      );
    }
  }

  for (final arabic in [false, true]) {
    for (final tab in [1, 2, 3]) {
      testWidgets('main tab $tab renders (${arabic ? 'ar' : 'en'})', (
        tester,
      ) async {
        await _render(
          tester,
          const MainShell(),
          arabic: arabic,
          setup: (s) => s.tab = tab,
        );
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('track screen at completed stage shows rate button', (
    tester,
  ) async {
    await _render(
      tester,
      const TrackScreen(),
      arabic: false,
      setup: (s) => s.stage = 6,
    );
    expect(find.text('Rate your service'), findsOneWidget);
    expect(tester.takeException(), isNull);
  }, skip: !kDemoData);

  testWidgets('arabic app is right-to-left', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await _render(tester, const LoginScreen(), arabic: true);
    final dir = Directionality.of(tester.element(find.byType(LoginScreen)));
    expect(dir, TextDirection.rtl);
  });

  testWidgets('app boots into the splash screen', (tester) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final kit = TestHsClient();
    await kit.client.auth
        .restore(); // no saved session: the splash goes on to onboarding
    await tester.pumpWidget(App(client: kit.client));
    expect(find.text('Home Services'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 2300));
    await tester.pump(const Duration(milliseconds: 500));
    // Onboarding with the language dialog open.
    expect(find.text('Choose your preferred language'), findsOneWidget);
  });
}
