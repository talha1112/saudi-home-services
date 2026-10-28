import 'support/worker_harness.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/jobs/screens/demo_active_job_screen.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/features/authentication/screens/otp_screen.dart';
import 'package:worker_app/features/dashboard/screens/main_shell.dart';
import 'package:worker_app/features/earnings/screens/earnings_screen.dart';
import 'package:worker_app/features/messages/screens/chat_screen.dart';
import 'package:worker_app/features/notifications/screens/notifications_screen.dart';
import 'package:worker_app/features/onboarding/screens/welcome_screen.dart';
import 'package:worker_app/features/quotes/screens/quote_screen.dart';
import 'package:worker_app/features/quotes/screens/quote_status_screen.dart';
import 'package:worker_app/features/requests/screens/request_screen.dart';
import 'package:worker_app/features/subscriptions/screens/subscription_screen.dart';
import 'package:worker_app/shared/models/worker_data.dart';
import 'package:worker_app/shared/components/phone_field.dart';

/// The test font is very wide, so load the bundled fonts for real metrics.
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
  addTearDown(kit.client.auth.dispose);
  final services = makeJobsServices(kit);
  addTearDown(services.jobs.dispose);
  addTearDown(services.quotes.dispose);
  await kit.client.auth.restore(); // as main() does before the app starts
  await tester.pumpWidget(
    workerHarness(
      kit: kit,
      services: services,
      state: state,
      home: screen,
      arabic: arabic,
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  setUpAll(_loadFonts);

  void accepted(AppState s) {
    s.quoteState = QuoteState.accepted;
    s.stage = 1;
  }

  final screens =
      <String, ({Widget Function() build, void Function(AppState)? setup})>{
        'welcome': (build: () => const WelcomeScreen(), setup: null),
        'otp': (build: () => const OtpScreen(), setup: null),
        'home': (build: () => const MainShell(), setup: null),
        'jobs': (build: () => const MainShell(), setup: (s) => s.tab = 1),
        'jobs quoted': (
          build: () => const MainShell(),
          setup: (s) {
            s.tab = 1;
            s.jobsTab = 1;
            s.quoteState = QuoteState.pending;
          },
        ),
        'jobs completed': (
          build: () => const MainShell(),
          setup: (s) {
            s.tab = 1;
            s.jobsTab = 4;
            accepted(s);
            s.stage = 4;
          },
        ),
        'earnings': (build: () => const MainShell(), setup: (s) => s.tab = 2),
        'profile': (build: () => const MainShell(), setup: (s) => s.tab = 3),
        'earnings alone': (
          build: () => const Scaffold(body: EarningsScreen()),
          setup: null,
        ),
        'request': (build: () => const RequestScreen(), setup: null),
        'quote': (build: () => const QuoteScreen(), setup: null),
        'quote status pending': (
          build: () => const QuoteStatusScreen(),
          setup: (s) => s.quoteState = QuoteState.pending,
        ),
        'quote status accepted': (
          build: () => const QuoteStatusScreen(),
          setup: accepted,
        ),
        'quote status rejected': (
          build: () => const QuoteStatusScreen(),
          setup: (s) => s.quoteState = QuoteState.rejected,
        ),
        'active': (build: () => const DemoActiveJobScreen(), setup: accepted),
        'active done': (
          build: () => const DemoActiveJobScreen(),
          setup: (s) {
            accepted(s);
            s.stage = 4;
          },
        ),
        'chat': (build: () => const ChatScreen(), setup: null),
        'subscription': (build: () => const SubscriptionScreen(), setup: null),
        'notifications': (
          build: () => const NotificationsScreen(),
          setup: null,
        ),
      };

  // Screens built from invented jobs, quotes, stages and prices exist only in demo builds:
  //   flutter test --dart-define=DEMO_DATA=true test/widget_test.dart
  const demoOnly = {
    'request',
    'quote',
    'quote status pending',
    'quote status accepted',
    'quote status rejected',
    'active',
    'active done',
  };

  for (final arabic in [false, true]) {
    for (final entry in screens.entries) {
      testWidgets(
        '${entry.key} renders (${arabic ? 'ar' : 'en'})',
        (tester) async {
          await _render(
            tester,
            entry.value.build(),
            arabic: arabic,
            setup: entry.value.setup,
          );
          expect(tester.takeException(), isNull);
        },
        skip: demoOnly.contains(entry.key) && !kDemoData,
      );
    }
  }

  testWidgets('quote totals use the plan commission', (tester) async {
    final state = AppState();
    expect(state.gross, 250);
    expect(state.commission, 37.5);
    expect(state.net, 212.5);
    state.planId = 'elite';
    expect(state.commission, 30);
  });

  testWidgets('welcome phone field stays reachable with the keyboard open', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    addTearDown(tester.view.resetViewInsets);
    final kit = TestHsClient();
    addTearDown(kit.client.auth.dispose);
    await kit.client.auth.restore(); // as main() does before the app starts
    await tester.pumpWidget(App(client: kit.client));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.tapAt(const Offset(10, 10)); // dismiss the language dialog
    await tester.pump(const Duration(milliseconds: 600));
    tester.view.viewInsets = const FakeViewPadding(bottom: 300 * 3);
    await tester.pump(const Duration(milliseconds: 600));
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byType(PhoneField));
    await tester.pump();
    expect(
      tester.getRect(find.byType(PhoneField)).bottom,
      lessThanOrEqualTo(640 - 300),
    );
  });

  testWidgets('app boots into the welcome screen with the language dialog', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final kit = TestHsClient();
    addTearDown(kit.client.auth.dispose);
    await kit.client.auth.restore(); // as main() does before the app starts
    await tester.pumpWidget(App(client: kit.client));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Choose your preferred language'), findsOneWidget);
  });
}
