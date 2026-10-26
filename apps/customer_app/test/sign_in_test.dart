import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/features/authentication/screens/login_screen.dart';
import 'package:customer_app/features/authentication/screens/otp_screen.dart';
import 'package:customer_app/features/home/screens/main_shell.dart';
import 'support/booking_harness.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

/// Drives the real sign-in screens end to end. Firebase and the backend are test doubles (hs_client/testing.dart): this proves the app
/// wiring (screens -> controller -> Firebase gateway -> backend exchange -> session -> home), not Firebase itself.
Future<TestHsClient> _pump(WidgetTester tester, {bool arabic = false}) async {
  tester.view.physicalSize = const Size(390 * 3, 844 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final kit = TestHsClient();
  addTearDown(kit.client.auth.dispose);
  await tester.pumpWidget(
    harness(
      kit: kit,
      services: makeServices(kit),
      state: AppState()..setArabic(arabic),
      home: const LoginScreen(),
      arabic: arabic,
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
  return kit;
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _enterPhoneAndSend(
  WidgetTester tester, {
  String label = 'Send code',
}) async {
  await tester.enterText(find.byType(TextField), '551234567');
  await tester.pump();
  await tester.tap(find.text(label));
  await _settle(tester);
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
    'phone number -> SMS code -> signed in: the number goes to Firebase as E.164 and the token to the backend',
    (tester) async {
      final kit = await _pump(tester);
      await _enterPhoneAndSend(tester);

      expect(kit.phone.lastPhone, '+966551234567');
      expect(find.byType(OtpScreen), findsOneWidget);
      expect(find.text('Enter the code'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('otp-input')), '123456');
      await _settle(tester);

      expect(kit.phone.lastCode, '123456');
      expect(
        kit.api.lastIdToken,
        'firebase-id-token-1',
      ); // the backend gets the Firebase token, never a phone number
      expect(kit.api.lastApp, AppKind.customer);
      expect(kit.client.auth.isSignedIn, isTrue);
      expect(find.byType(MainShell), findsOneWidget);
      await tester.pump(
        const Duration(seconds: 1),
      ); // the page transition finishes and the sign-in screens leave the stack
      expect(find.byType(OtpScreen), findsNothing);
      expect(find.byType(LoginScreen), findsNothing);
      await tester.pump(const Duration(seconds: 2));
    },
  );

  testWidgets(
    'a wrong code shows the reason, clears the boxes, and the right code then works',
    (tester) async {
      final kit = await _pump(tester);
      await _enterPhoneAndSend(tester);

      kit.phone.confirmResult = const PhoneAuthFailure(AuthIssue.invalidCode);
      await tester.enterText(find.byKey(const Key('otp-input')), '111111');
      await _settle(tester);
      expect(find.byKey(const Key('otp-error')), findsOneWidget);
      expect(
        find.text('That code is not correct. Check the SMS and try again.'),
        findsOneWidget,
      );
      expect(find.byType(OtpScreen), findsOneWidget);
      expect(kit.client.auth.isSignedIn, isFalse);

      kit.phone.confirmResult = 'firebase-id-token-2';
      await tester.enterText(find.byKey(const Key('otp-input')), '222222');
      await _settle(tester);
      expect(kit.client.auth.isSignedIn, isTrue);
      expect(find.byType(MainShell), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
    },
  );

  testWidgets(
    'a refused account (suspended) stays on the code screen with a clear message and no session',
    (tester) async {
      final kit = await _pump(tester);
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
    'if Firebase cannot send the SMS the person stays on the phone screen and sees why',
    (tester) async {
      final kit = await _pump(tester);
      kit.phone.sendResult = const PhoneAuthFailure(AuthIssue.tooManyRequests);
      await _enterPhoneAndSend(tester);
      expect(find.byType(OtpScreen), findsNothing);
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(
        find.text('Too many attempts. Please wait a while and try again.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('a number Firebase verifies instantly goes straight to the app', (
    tester,
  ) async {
    final kit = await _pump(tester);
    kit.phone.sendResult = const AutoVerified('instant-token');
    await _enterPhoneAndSend(tester);
    expect(kit.api.lastIdToken, 'instant-token');
    expect(find.byType(MainShell), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets(
    'the code screen counts down before "resend" is offered, and "change number" returns to the phone screen',
    (tester) async {
      await _pump(tester);
      await _enterPhoneAndSend(tester);
      expect(find.textContaining('Resend code in'), findsOneWidget);
      expect(find.byKey(const Key('otp-resend')), findsNothing);
      await tester.tap(find.text('Change number'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(LoginScreen), findsOneWidget);
    },
  );

  testWidgets('Arabic: the same flow shows Arabic messages', (tester) async {
    final kit = await _pump(tester, arabic: true);
    kit.phone.sendResult = const PhoneAuthFailure(AuthIssue.network);
    await _enterPhoneAndSend(tester, label: 'إرسال الرمز');
    expect(
      find.text('لا يوجد اتصال. تحقق من الإنترنت وحاول مجدداً.'),
      findsOneWidget,
    );
  });
}
