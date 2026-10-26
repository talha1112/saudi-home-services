import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app.dart';
import 'package:worker_app/features/authentication/screens/otp_screen.dart';
import 'package:worker_app/features/dashboard/screens/main_shell.dart';
import 'package:worker_app/features/onboarding/screens/welcome_screen.dart';
import 'package:worker_app/features/verification/screens/apply_screen.dart';
import 'package:worker_app/features/verification/screens/status_screen.dart';

/// Drives the real worker app from the welcome screen through sign-in. Firebase and the backend are test doubles (hs_client/testing.dart):
/// this proves the app wiring (screens -> controller -> Firebase gateway -> backend exchange -> session -> where the worker belongs).
Future<TestHsClient> _pump(WidgetTester tester, {String? status}) async {
  tester.view.physicalSize = const Size(390 * 3, 844 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final kit = TestHsClient(
    kind: AppKind.worker,
    user: fakeUser(role: 'WORKER', workerStatus: status),
  );
  addTearDown(kit.client.auth.dispose);
  await tester.pumpWidget(App(client: kit.client));
  await tester.pump(const Duration(milliseconds: 600));
  await tester.tapAt(const Offset(10, 10)); // dismiss the language dialog
  await tester.pump(const Duration(milliseconds: 600));
  return kit;
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _enterPhoneAndSend(WidgetTester tester) async {
  await tester.enterText(find.byType(TextField), '551234567');
  await tester.pump();
  await tester.tap(find.text('Send code'));
  await _settle(tester);
}

Future<void> _signInWithCode(WidgetTester tester, TestHsClient kit) async {
  await _enterPhoneAndSend(tester);
  expect(kit.phone.lastPhone, '+966551234567');
  expect(find.byType(OtpScreen), findsOneWidget);
  await tester.enterText(find.byKey(const Key('otp-input')), '123456');
  await _settle(tester);
  await tester.pump(const Duration(seconds: 2)); // page transition
}

/// The real app fonts, so layouts match what a phone shows (the default test font is much wider).
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

  testWidgets(
    'a new worker signs in with the SMS code and lands on the application form; the backend gets the Firebase token with the worker app kind',
    (tester) async {
      final kit = await _pump(tester, status: 'NOT_SUBMITTED');
      await _signInWithCode(tester, kit);

      expect(kit.phone.lastCode, '123456');
      expect(kit.api.lastIdToken, 'firebase-id-token-1');
      expect(kit.api.lastApp, AppKind.worker);
      expect(kit.client.auth.isSignedIn, isTrue);
      expect(find.byType(ApplyScreen), findsOneWidget);
      expect(find.byType(OtpScreen), findsNothing);
      expect(find.byType(WelcomeScreen), findsNothing);
    },
  );

  testWidgets('an approved worker goes straight to the dashboard', (
    tester,
  ) async {
    final kit = await _pump(tester, status: 'APPROVED');
    await _signInWithCode(tester, kit);
    expect(find.byType(MainShell), findsOneWidget);
    expect(find.byType(ApplyScreen), findsNothing);
  });

  for (final status in [
    'SUBMITTED',
    'UNDER_REVIEW',
    'INFO_REQUIRED',
    'REJECTED',
  ]) {
    testWidgets('a $status worker sees the review status, not the dashboard', (
      tester,
    ) async {
      final kit = await _pump(tester, status: status);
      await _signInWithCode(tester, kit);
      expect(find.byType(StatusScreen), findsOneWidget);
      expect(find.byType(MainShell), findsNothing);
    });
  }

  testWidgets(
    'a wrong code shows the reason, clears the boxes, and the right code then works',
    (tester) async {
      final kit = await _pump(tester, status: 'NOT_SUBMITTED');
      await _enterPhoneAndSend(tester);
      kit.phone.confirmResult = const PhoneAuthFailure(AuthIssue.invalidCode);
      await tester.enterText(find.byKey(const Key('otp-input')), '111111');
      await _settle(tester);
      expect(find.byKey(const Key('otp-error')), findsOneWidget);
      expect(find.byType(OtpScreen), findsOneWidget);
      expect(kit.client.auth.isSignedIn, isFalse);

      kit.phone.confirmResult = 'firebase-id-token-2';
      await tester.enterText(find.byKey(const Key('otp-input')), '222222');
      await _settle(tester);
      await tester.pump(const Duration(seconds: 2));
      expect(kit.client.auth.isSignedIn, isTrue);
      expect(find.byType(ApplyScreen), findsOneWidget);
    },
  );

  testWidgets(
    'a refused account (suspended) stays on the code screen with no session',
    (tester) async {
      final kit = await _pump(tester, status: 'APPROVED');
      kit.api.signInResult = const ApiException(
        status: 403,
        code: 'ACCOUNT_SUSPENDED',
      );
      await _enterPhoneAndSend(tester);
      await tester.enterText(find.byKey(const Key('otp-input')), '123456');
      await _settle(tester);
      expect(
        find.text('This account has been suspended. Contact support.'),
        findsOneWidget,
      );
      expect(kit.client.auth.isSignedIn, isFalse);
      expect(find.byType(MainShell), findsNothing);
    },
  );

  testWidgets(
    'if Firebase cannot send the SMS the worker stays on the phone screen and sees why',
    (tester) async {
      final kit = await _pump(tester);
      kit.phone.sendResult = const PhoneAuthFailure(AuthIssue.tooManyRequests);
      await _enterPhoneAndSend(tester);
      expect(find.byType(OtpScreen), findsNothing);
      expect(find.byType(WelcomeScreen), findsOneWidget);
      expect(
        find.text('Too many attempts. Please wait a while and try again.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('a number Firebase verifies instantly skips the code screen', (
    tester,
  ) async {
    final kit = await _pump(tester, status: 'APPROVED');
    kit.phone.sendResult = const AutoVerified('instant-token');
    await _enterPhoneAndSend(tester);
    await tester.pump(const Duration(seconds: 2));
    expect(kit.api.lastIdToken, 'instant-token');
    expect(find.byType(MainShell), findsOneWidget);
  });
}
