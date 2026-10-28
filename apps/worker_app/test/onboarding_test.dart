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
import 'package:worker_app/features/verification/services/document_picker.dart';

/// Drives the real worker app (welcome -> code -> application / status) against the stateful fake backend in hs_client/testing.dart.
/// Firebase and the HTTP layer are doubles, so these tests prove the screens, the controller and the request sequence, not the server.
class _FakePicker implements DocumentPicker {
  PickedDocument? next;
  int picks = 0;
  bool? lastImagesOnly;

  @override
  bool get hasCamera => false;

  @override
  Future<PickedDocument?> takePhoto() async => null;

  @override
  Future<PickedDocument?> pick({bool imagesOnly = false}) async {
    lastImagesOnly = imagesOnly;
    picks++;
    return next;
  }
}

class _Rig {
  _Rig(WidgetTester tester, {String status = 'NOT_SUBMITTED'})
    : kit = TestHsClient(
        kind: AppKind.worker,
        user: fakeUser(role: 'WORKER', workerStatus: status),
      ) {
    kit.api.workerStatus = status;
    picker.next = PickedDocument(
      name: 'iqama.pdf',
      bytes: Uint8List.fromList(List.filled(4096, 7)),
    );
  }

  final TestHsClient kit;
  final picker = _FakePicker();
  FakeApi get api => kit.api;
  WorkerOnboardingController get ob => kit.client.onboarding;

  /// A complete application on the (fake) server, so only the step under test is missing.
  void fillServer({bool identity = true}) {
    api.fullName = 'Ahmed Al-Qahtani';
    api.yearsOfExperience = 4;
    api.workerServices.add('svc-ac');
    api.workerCities.add('city-ruh');
    api.workerWindows = const [
      AvailabilityWindow(dayOfWeek: 0, startTime: '08:00', endTime: '17:00'),
    ];
    // the profile photo of step 1
    api.workerDocuments.add({
      'id': 'doc-photo',
      'type': 'PHOTO',
      'status': 'UPLOADED',
      'fileName': 'me.jpg',
      'mimeType': 'image/jpeg',
      'sizeBytes': 2048,
      'expiresOn': null,
      'reviewNote': null,
      'scanStatus': 'PENDING',
      'createdAt': '2026-11-01T10:00:00.000Z',
    });
    if (identity) {
      api.workerDocuments.add({
        'id': 'doc-seed',
        'type': 'IQAMA',
        'status': 'UPLOADED',
        'fileName': 'iqama.pdf',
        'mimeType': 'application/pdf',
        'sizeBytes': 4096,
        'expiresOn': null,
        'reviewNote': null,
        'scanStatus': 'PENDING',
        'createdAt': '2026-11-01T10:00:00.000Z',
      });
    }
  }
}

Future<void> _settle(WidgetTester tester, [int times = 4]) async {
  for (var i = 0; i < times; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<_Rig> _launch(
  WidgetTester tester, {
  String status = 'NOT_SUBMITTED',
  void Function(_Rig)? prepare,
}) async {
  tester.view.physicalSize = const Size(390 * 3, 1000 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final rig = _Rig(tester, status: status);
  prepare?.call(rig);
  addTearDown(rig.kit.client.auth.dispose);
  await rig.kit.client.auth.restore(); // as main() does before the app starts
  await tester.pumpWidget(
    App(client: rig.kit.client, documentPicker: rig.picker),
  );
  await tester.pump(const Duration(milliseconds: 600));
  await tester.tapAt(const Offset(10, 10)); // dismiss the language dialog
  await tester.pump(const Duration(milliseconds: 600));
  return rig;
}

/// Phone number -> SMS code (Firebase double) -> backend exchange, then lets the post-sign-in routing and first load finish.
Future<void> _signIn(WidgetTester tester) async {
  await tester.enterText(find.byType(TextField), '551234567');
  await tester.pump();
  await tester.tap(find.text('Send code'));
  await _settle(tester);
  expect(find.byType(OtpScreen), findsOneWidget);
  await tester.enterText(find.byKey(const Key('otp-input')), '123456');
  await _settle(tester);
  await tester.pump(const Duration(seconds: 2));
  await _settle(tester);
}

Future<void> _tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.tap(find.text(text));
  await _settle(tester);
}

Future<void> _tapKey(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  await tester.tap(find.byKey(key));
  await _settle(tester);
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

  group('application form -> backend', () {
    testWidgets(
      'a new worker fills the four steps, each one is saved to the server, the document goes through the signed upload, and submitting reaches the status screen',
      (tester) async {
        final rig = await _launch(tester);
        await _signIn(tester);
        expect(find.byType(ApplyScreen), findsOneWidget);
        expect(rig.api.onboardingCalls, contains('workerOnboarding'));

        // step 1: the Continue button stays disabled until the details are valid, then the profile is PUT
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), 'Ahmed Al-Qahtani');
        await tester.enterText(fields.at(2), '4');
        await _settle(tester);
        // the profile photo is part of step 1: Continue stays off until the server has confirmed it
        expect(
          find.text('Required: a clear photo of your face (JPEG or PNG)'),
          findsOneWidget,
        );
        await _tapKey(tester, const Key('upload-PHOTO'));
        expect(
          rig.picker.lastImagesOnly,
          isTrue,
          reason: 'a photo can only be an image',
        );
        expect(rig.api.workerDocuments.single['type'], 'PHOTO');
        await _tapText(tester, 'Save and continue');
        expect(rig.api.fullName, 'Ahmed Al-Qahtani');
        expect(rig.api.yearsOfExperience, 4);

        // step 2: services and cities come from the server's catalog
        expect(find.text('AC repair'), findsOneWidget);
        await _tapKey(tester, const Key('service-svc-ac'));
        await _tapKey(tester, const Key('city-city-ruh'));
        await _tapText(tester, 'Save and continue');
        expect(rig.api.workerServices, {'svc-ac'});
        expect(rig.api.workerCities, {'city-ruh'});

        // step 3: working days (backend numbering: 0 = Sunday) and hours
        await _tapKey(tester, const Key('day-0'));
        await _tapKey(tester, const Key('day-1'));
        await _tapText(tester, 'Save and continue');
        expect(
          rig.api.workerWindows.map(
            (w) => (w.dayOfWeek, w.startTime, w.endTime),
          ),
          [(0, '08:00', '17:00'), (1, '08:00', '17:00')],
        );

        // step 4: upload (register -> PUT to the signed address -> confirm), then submit
        await _tapKey(tester, const Key('upload-IQAMA'));
        expect(rig.picker.picks, 2); // the photo, then the identity document
        expect(
          rig.api.onboardingCalls,
          containsAllInOrder([
            'registerWorkerDocument',
            'uploadToSignedUrl',
            'confirmWorkerDocument',
          ]),
        );
        expect(rig.api.signedUploads, 2); // the photo and the identity document
        expect(
          find.text('Received, being checked'),
          findsOneWidget,
        ); // the server's scan state, shown as is
        await _tapText(tester, 'Submit for review');
        await tester.pump(const Duration(seconds: 2));
        expect(rig.api.onboardingCalls, contains('submitWorkerVerification'));
        expect(rig.api.workerStatus, 'SUBMITTED');
        expect(find.byType(StatusScreen), findsOneWidget);
        expect(find.text('We received your application'), findsOneWidget);
        expect(rig.kit.client.auth.user!.workerVerificationStatus, 'SUBMITTED');
      },
    );

    testWidgets(
      'the form is filled from what the server already has, so a started application can be continued',
      (tester) async {
        final rig = await _launch(
          tester,
          prepare: (r) => r.fillServer(identity: false),
        );
        await _signIn(tester);
        expect(find.byType(ApplyScreen), findsOneWidget);
        expect(find.text('Ahmed Al-Qahtani'), findsOneWidget);
        expect(rig.api.fullName, 'Ahmed Al-Qahtani');
      },
    );

    testWidgets(
      'a server validation error is shown, the step does not advance and nothing is pretended saved',
      (tester) async {
        final rig = await _launch(tester);
        await _signIn(tester);
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), 'Ahmed Al-Qahtani');
        await tester.enterText(fields.at(2), '4');
        await _settle(tester);
        await _tapKey(tester, const Key('upload-PHOTO'));
        rig.api.failures['updateWorkerProfile'] = const ApiException(
          status: 400,
          code: 'HTTP_400',
          fieldMessages: [
            'fullNameAr must be longer than or equal to 2 characters',
          ],
        );
        await _tapText(tester, 'Save and continue');
        expect(find.byKey(const Key('apply-error')), findsOneWidget);
        expect(
          find.textContaining('fullNameAr must be longer'),
          findsOneWidget,
        );
        expect(find.text('Step 1 of 4'), findsOneWidget);
        expect(rig.api.fullName, isNull);
      },
    );

    testWidgets(
      'a lost connection while saving is reported and the same step can be retried',
      (tester) async {
        final rig = await _launch(tester);
        await _signIn(tester);
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), 'Ahmed Al-Qahtani');
        await tester.enterText(fields.at(2), '4');
        await _settle(tester);
        await _tapKey(tester, const Key('upload-PHOTO'));
        rig.api.failures['updateWorkerProfile'] = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await _tapText(tester, 'Save and continue');
        expect(find.textContaining('No connection'), findsOneWidget);
        expect(find.text('Step 1 of 4'), findsOneWidget);
        await _tapText(tester, 'Save and continue');
        expect(find.text('Step 2 of 4'), findsOneWidget);
      },
    );

    testWidgets(
      'with document storage unavailable the upload is refused honestly: nothing is shown as uploaded',
      (tester) async {
        final rig = await _launch(
          tester,
          prepare: (r) => r.fillServer(identity: false),
        );
        await _signIn(tester);
        for (var i = 0; i < 3; i++) {
          await _tapText(tester, 'Save and continue');
        }
        expect(find.text('Step 4 of 4'), findsOneWidget);
        rig.api.failures['registerWorkerDocument'] = const ApiException(
          status: 503,
          code: 'DOCUMENT_STORAGE_NOT_CONFIGURED',
        );
        await _tapKey(tester, const Key('upload-IQAMA'));
        expect(
          find.textContaining('Document upload is not available'),
          findsOneWidget,
        );
        expect(rig.api.signedUploads, 0);
        expect(
          rig.api.workerDocuments.where((d) => d['type'] != 'PHOTO'),
          isEmpty,
        );
        expect(find.byKey(const Key('remove-doc-1')), findsNothing);
      },
    );

    testWidgets(
      'a file the server rejects after inspecting it is reported and does not count',
      (tester) async {
        final rig = await _launch(
          tester,
          prepare: (r) => r.fillServer(identity: false),
        );
        await _signIn(tester);
        for (var i = 0; i < 3; i++) {
          await _tapText(tester, 'Save and continue');
        }
        rig.api.failures['confirmWorkerDocument'] = const ApiException(
          status: 422,
          code: 'FILE_REJECTED_BY_SCAN',
        );
        await _tapKey(tester, const Key('upload-IQAMA'));
        expect(find.textContaining('The file was rejected'), findsOneWidget);
        expect(
          rig.api.workerDocuments.where((d) => d['type'] != 'PHOTO'),
          isEmpty,
        ); // the half-finished record was cleaned up
      },
    );

    testWidgets(
      'a file type the backend does not accept is refused on the phone without any request',
      (tester) async {
        final rig = await _launch(
          tester,
          prepare: (r) => r.fillServer(identity: false),
        );
        rig.picker.next = PickedDocument(
          name: 'cv.docx',
          bytes: Uint8List(2000),
        );
        await _signIn(tester);
        for (var i = 0; i < 3; i++) {
          await _tapText(tester, 'Save and continue');
        }
        final before = rig.api.onboardingCalls.length;
        await _tapKey(tester, const Key('upload-NATIONAL_ID'));
        expect(find.textContaining('Only JPG, PNG or PDF'), findsOneWidget);
        expect(rig.api.onboardingCalls.length, before);
      },
    );

    testWidgets(
      'submitting without an identity document is refused by the server and the missing item is named',
      (tester) async {
        final rig = await _launch(
          tester,
          prepare: (r) => r.fillServer(identity: false),
        );
        await _signIn(tester);
        for (var i = 0; i < 3; i++) {
          await _tapText(tester, 'Save and continue');
        }
        await _tapText(tester, 'Submit for review');
        expect(
          find.textContaining('Still needed: Identity document'),
          findsOneWidget,
        );
        expect(rig.api.workerStatus, 'NOT_SUBMITTED');
        expect(find.byType(StatusScreen), findsNothing);
      },
    );

    testWidgets(
      'an expired session while saving returns the worker to sign-in',
      (tester) async {
        final rig = await _launch(tester);
        await _signIn(tester);
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), 'Ahmed Al-Qahtani');
        await tester.enterText(fields.at(2), '4');
        await _settle(tester);
        await _tapKey(tester, const Key('upload-PHOTO'));
        rig.api.failures['updateWorkerProfile'] = const ApiException(
          status: 401,
          code: 'UNAUTHORIZED',
        );
        rig.api.refreshResults.add(
          const ApiException(status: 401, code: 'REFRESH_TOKEN_REVOKED'),
        );
        await _tapText(tester, 'Save and continue');
        await tester.pump(const Duration(seconds: 1));
        expect(rig.kit.client.auth.status, AuthStatus.signedOut);
        expect(find.byType(WelcomeScreen), findsOneWidget);
      },
    );
  });

  group('status from the server', () {
    final cases = {
      'SUBMITTED': 'We received your application',
      'UNDER_REVIEW': 'Your application is being reviewed',
      'INFO_REQUIRED': 'We need a little more information',
      'REJECTED': 'Your application was not accepted',
      'SUSPENDED': 'Your account is suspended',
    };
    for (final entry in cases.entries) {
      testWidgets(
        '${entry.key}: signing in shows the status screen with the server\'s state, not the dashboard',
        (tester) async {
          await _launch(
            tester,
            status: entry.key,
            prepare: (r) => r.fillServer(),
          );
          await _signIn(tester);
          expect(find.byType(StatusScreen), findsOneWidget);
          expect(find.text(entry.value), findsOneWidget);
          expect(find.byType(MainShell), findsNothing);
        },
      );
    }

    testWidgets('the reviewer\'s message is shown for INFO_REQUIRED', (
      tester,
    ) async {
      await _launch(
        tester,
        status: 'INFO_REQUIRED',
        prepare: (r) {
          r.fillServer();
          r.api.reviewerNote = 'The Iqama photo is blurry';
        },
      );
      await _signIn(tester);
      expect(find.byKey(const Key('status-note')), findsOneWidget);
      expect(find.text('The Iqama photo is blurry'), findsOneWidget);
    });

    testWidgets('an approved worker goes straight to the dashboard', (
      tester,
    ) async {
      await _launch(tester, status: 'APPROVED', prepare: (r) => r.fillServer());
      await _signIn(tester);
      expect(find.byType(MainShell), findsOneWidget);
      expect(find.byType(StatusScreen), findsNothing);
    });

    testWidgets(
      'an approval that happens while waiting appears on refresh, and then the dashboard is one tap away',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'SUBMITTED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        expect(find.text('We received your application'), findsOneWidget);
        rig.api.workerStatus = 'APPROVED';
        await _tapKey(tester, const Key('status-refresh'));
        expect(find.text('You are approved'), findsOneWidget);
        expect(rig.kit.client.auth.user!.workerVerificationStatus, 'APPROVED');
        await _tapText(tester, 'Go to dashboard');
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(MainShell), findsOneWidget);
      },
    );

    testWidgets(
      'returning to the app refreshes the status, but not more often than the throttle allows',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'SUBMITTED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        int loads() => rig.api.onboardingCalls
            .where((c) => c == 'workerOnboarding')
            .length;
        final first = loads();
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await _settle(tester);
        expect(
          loads(),
          first,
          reason: 'within the throttle window the server is not asked again',
        );
        rig.api.workerStatus = 'APPROVED';
        await rig.ob.refresh(
          force: true,
        ); // what a resume after the window does
        await _settle(tester);
        expect(find.text('You are approved'), findsOneWidget);
      },
    );

    testWidgets(
      'a worker sent back with INFO_REQUIRED can edit and resubmit; the server decides',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'INFO_REQUIRED',
          prepare: (r) {
            r.fillServer();
            r.api.reviewerNote = 'Please upload a clearer photo';
          },
        );
        await _signIn(tester);
        await _tapText(tester, 'Review and update my application');
        expect(find.byType(ApplyScreen), findsOneWidget);
        for (var i = 0; i < 3; i++) {
          await _tapText(tester, 'Save and continue');
        }
        expect(find.text('Update and resubmit'), findsOneWidget);
        await _tapText(tester, 'Update and resubmit');
        await tester.pump(const Duration(seconds: 2));
        expect(rig.api.workerStatus, 'SUBMITTED');
        expect(find.byType(StatusScreen), findsOneWidget);
        expect(find.text('We received your application'), findsOneWidget);
      },
    );

    testWidgets(
      'a status load that fails is shown with a refresh option; the session expiring sends the worker to sign-in',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'SUBMITTED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        rig.api.failures['workerOnboarding'] = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await _tapKey(tester, const Key('status-refresh'));
        expect(find.byKey(const Key('status-error')), findsOneWidget);
        expect(
          find.text('We received your application'),
          findsOneWidget,
        ); // the last known server state stays visible
        rig.api.failures['workerOnboarding'] = const ApiException(
          status: 401,
          code: 'UNAUTHORIZED',
        );
        rig.api.refreshResults.add(
          const ApiException(status: 401, code: 'REFRESH_TOKEN_REVOKED'),
        );
        await _tapKey(tester, const Key('status-refresh'));
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(WelcomeScreen), findsOneWidget);
      },
    );
  });

  group('contacting support when the application is not approved', () {
    const states = [
      'SUBMITTED',
      'UNDER_REVIEW',
      'INFO_REQUIRED',
      'REJECTED',
      'SUSPENDED',
      'NOT_SUBMITTED',
    ];

    for (final status in states) {
      testWidgets('$status: the status screen offers "Contact support"', (
        tester,
      ) async {
        await _launch(tester, status: status, prepare: (r) => r.fillServer());
        await _signIn(tester);
        if (status == 'NOT_SUBMITTED') {
          // an unfinished application is on the form, not the status screen
          expect(find.byType(ApplyScreen), findsOneWidget);
          return;
        }
        expect(find.byType(StatusScreen), findsOneWidget);
        expect(find.byKey(const Key('contact-support')), findsOneWidget);
        expect(find.text('Contact support'), findsOneWidget);
      });
    }

    testWidgets('an approved worker status screen has no such button', (
      tester,
    ) async {
      await _launch(tester, status: 'APPROVED', prepare: (r) => r.fillServer());
      await _signIn(tester);
      expect(find.byKey(const Key('contact-support')), findsNothing);
    });

    testWidgets(
      'a rejected worker writes to support, the message is stored, and the reply from the administrator appears',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'REJECTED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        await _tapKey(tester, const Key('contact-support'));

        expect(find.text('Support'), findsOneWidget);
        expect(
          find.text('Tell us how we can help. Our team replies here.'),
          findsOneWidget,
        );
        expect(
          find.text('On my way'),
          findsNothing,
          reason: 'the booking quick replies do not belong in support',
        );

        await tester.enterText(
          find.byKey(const Key('chat-input')),
          'My ID photo was rejected, what should I upload?',
        );
        await tester.tap(find.byKey(const Key('chat-send')));
        await _settle(tester);
        expect(
          rig.api.supportStore.single.body,
          'My ID photo was rejected, what should I upload?',
        );
        expect(
          find.text('My ID photo was rejected, what should I upload?'),
          findsOneWidget,
        );

        rig.api.supportAdminReply(
          'Please upload a clearer photo of the front of your ID.',
        );
        await tester.pump(const Duration(seconds: 4));
        await _settle(tester);
        expect(
          find.text('Please upload a clearer photo of the front of your ID.'),
          findsOneWidget,
        );
      },
    );

    testWidgets('earlier messages are there when the worker comes back', (
      tester,
    ) async {
      final rig = await _launch(
        tester,
        status: 'SUSPENDED',
        prepare: (r) {
          r.fillServer();
          r.api.supportStore.add(
            ChatMessage(
              id: 's1',
              clientMessageId: 'old-0001',
              body: 'Why am I suspended?',
              fromMe: true,
              delivery: ChatDelivery.sent,
              seq: 1,
              createdAt: DateTime.now().toUtc(),
            ),
          );
          r.api.supportAdminReply(
            'A document expired. Please upload a new one.',
          );
        },
      );
      await _signIn(tester);
      await _tapKey(tester, const Key('contact-support'));
      expect(find.text('Why am I suspended?'), findsOneWidget);
      expect(
        find.text('A document expired. Please upload a new one.'),
        findsOneWidget,
      );
      expect(rig.api.supportSent, isEmpty);
    });

    testWidgets(
      'no connection: the message is kept as failed and sent once when retried',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'INFO_REQUIRED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        await _tapKey(tester, const Key('contact-support'));
        rig.api.supportSendResult = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await tester.enterText(find.byKey(const Key('chat-input')), 'hello');
        await tester.tap(find.byKey(const Key('chat-send')));
        await _settle(tester);
        expect(find.text('Not sent. Tap to retry'), findsOneWidget);
        rig.api.supportSendResult = null;
        await tester.tap(find.byKey(const Key('msg-0')));
        await _settle(tester);
        expect(rig.api.supportStore, hasLength(1));
        expect(rig.api.supportSent.toSet(), hasLength(1));
      },
    );
  });

  group('push notifications to a worker whose application is not approved', () {
    const decided = PushEvent(
      notificationId: 'n-approved',
      type: 'verification.approved',
      resourceType: 'worker_verification',
      resourceId: 'w-1',
      title: 'Your account was approved',
      body: 'Your verification was approved.',
    );
    const reply = PushEvent(
      notificationId: 'n-reply',
      type: 'support.reply',
      resourceType: 'support_thread',
      resourceId: 't-1',
      title: 'Support replied',
      body: 'You have a new reply from support.',
    );

    testWidgets(
      'a decision arrives while the app is open: the status screen updates by itself and the worker is told',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'SUBMITTED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        expect(find.text('We received your application'), findsOneWidget);

        rig.api.workerStatus =
            'APPROVED'; // the administrator approved on the server
        rig.kit.push.foregroundEvents.add(decided);
        await _settle(tester);

        expect(find.byKey(const Key('push-snackbar')), findsOneWidget);
        expect(find.textContaining('Your account was approved'), findsWidgets);
        expect(find.text('Go to dashboard'), findsOneWidget);
        expect(find.text('We received your application'), findsNothing);
      },
    );

    testWidgets(
      'a reply from support arrives while the app is open: the worker is told and "Open" goes to the conversation',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'REJECTED',
          prepare: (r) {
            r.fillServer();
            r.api.supportAdminReply('Please upload a clearer ID photo.');
          },
        );
        await _signIn(tester);

        rig.kit.push.foregroundEvents.add(reply);
        await _settle(tester);
        expect(find.byKey(const Key('push-snackbar')), findsOneWidget);
        expect(
          find.textContaining('You have a new reply from support.'),
          findsOneWidget,
        );

        await tester.tap(find.text('Open'));
        await _settle(tester);
        expect(find.text('Support'), findsOneWidget);
        expect(find.text('Please upload a clearer ID photo.'), findsOneWidget);
      },
    );

    testWidgets(
      'tapping the system notification for a reply opens the support conversation',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'INFO_REQUIRED',
          prepare: (r) {
            r.fillServer();
            r.api.supportAdminReply('We need a clearer photo.');
          },
        );
        await _signIn(tester);

        rig.kit.push.openedEvents.add(reply);
        await _settle(tester);
        expect(find.byKey(const Key('chat-input')), findsOneWidget);
        expect(find.text('We need a clearer photo.'), findsOneWidget);
      },
    );

    testWidgets(
      'tapping the notification for a decision opens the status screen showing the new state',
      (tester) async {
        final rig = await _launch(
          tester,
          status: 'SUBMITTED',
          prepare: (r) => r.fillServer(),
        );
        await _signIn(tester);
        // the worker is somewhere else (the support conversation) when the decision is tapped
        await _tapKey(tester, const Key('contact-support'));
        expect(find.byKey(const Key('chat-input')), findsOneWidget);

        rig.api.workerStatus = 'REJECTED';
        rig.kit.push.openedEvents.add(
          const PushEvent(
            notificationId: 'n-rej',
            type: 'verification.rejected',
          ),
        );
        await _settle(tester);
        expect(find.byType(StatusScreen), findsWidgets);
        expect(find.text('Your application was not accepted'), findsOneWidget);
      },
    );

    testWidgets('after sign-out a push does nothing', (tester) async {
      final rig = await _launch(
        tester,
        status: 'SUBMITTED',
        prepare: (r) => r.fillServer(),
      );
      await _signIn(tester);
      await rig.kit.client.auth.signOut();
      await _settle(tester);
      rig.kit.push.foregroundEvents.add(reply);
      rig.kit.push.openedEvents.add(reply);
      await _settle(tester);
      expect(find.byKey(const Key('push-snackbar')), findsNothing);
      expect(find.byKey(const Key('chat-input')), findsNothing);
    });
  });
}
