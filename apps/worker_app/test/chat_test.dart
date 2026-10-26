import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/core/config/demo_data.dart';
import 'package:worker_app/features/jobs/screens/active_job_screen.dart';
import 'package:worker_app/features/messages/screens/chat_screen.dart';
import 'package:worker_app/features/messages/widgets/chat_target.dart';

import 'support/worker_harness.dart';

/// The worker's side of the booking chat, through the real screen on the shared fake backend (the prototype screen, unchanged in layout).
const _target = ChatTarget(
  bookingId: 'job-1',
  peerName: 'Sara',
  subtitle: 'AC repair',
  peerPhone: '+966500000000',
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  if (kDemoData) return;
  setUpAll(loadWorkerFonts);

  Future<TestHsClient> open(
    WidgetTester tester, {
    ChatTarget target = _target,
    bool arabic = false,
    void Function(FakeApi)? arrange,
    Widget? home,
  }) async {
    phoneSize(tester, height: 1000);
    final kit = workerKit();
    await signInWorker(kit);
    kit.api.chatBookings.add('job-1');
    arrange?.call(kit.api);
    final services = makeJobsServices(kit);
    addTearDown(() {
      services.jobs.dispose();
      services.quotes.dispose();
      kit.client.auth.dispose();
    });
    await tester.pumpWidget(
      workerHarness(
        kit: kit,
        services: services,
        state: AppState()..setArabic(arabic),
        arabic: arabic,
        home: home ?? ChatScreen(target: target),
      ),
    );
    await _settle(tester);
    return kit;
  }

  testWidgets(
    'shows the real conversation, the customer\'s name and the service, none of the prototype\'s',
    (tester) async {
      await open(
        tester,
        arrange: (api) => api.chatPeerMessage('job-1', 'The gate code is 4821'),
      );
      expect(find.text('The gate code is 4821'), findsOneWidget);
      expect(
        find.text(
          'Hi Faisal, the gate code is 4821. Parking is in front of building 12.',
        ),
        findsNothing,
      );
      expect(find.text('Sara'), findsOneWidget);
      expect(find.text('AC repair'), findsOneWidget);
    },
  );

  testWidgets('sending, and a quick reply, both go to the backend', (
    tester,
  ) async {
    final kit = await open(tester);
    await tester.enterText(find.byType(TextField), 'Running late');
    await tester.tap(find.byKey(const Key('chat-send')));
    await _settle(tester);
    await tester.tap(find.text('On my way'));
    await _settle(tester);

    expect(kit.api.chatStore['job-1']!.map((m) => m.body), [
      'Running late',
      'On my way',
    ]);
    expect(find.text('Running late'), findsOneWidget);
  });

  testWidgets('what the customer writes appears while the screen is open', (
    tester,
  ) async {
    final kit = await open(tester);
    kit.api.chatPeerMessage('job-1', 'Please use the side door');
    await tester.pump(const Duration(seconds: 4));
    await _settle(tester);
    expect(find.text('Please use the side door'), findsOneWidget);
  });

  testWidgets(
    'a network failure is shown on the message and retried without a duplicate',
    (tester) async {
      final kit = await open(
        tester,
        arrange: (api) =>
            api.chatSendResult = const ApiException(status: 0, code: 'NETWORK'),
      );
      await tester.enterText(find.byType(TextField), 'hello');
      await tester.tap(find.byKey(const Key('chat-send')));
      await _settle(tester);
      expect(find.text('Not sent. Tap to retry'), findsOneWidget);
      kit.api.chatSendResult = null;
      await tester.tap(find.byKey(const Key('msg-0')));
      await _settle(tester);
      expect(kit.api.chatStore['job-1'], hasLength(1));
      expect(kit.api.chatSent.toSet(), hasLength(1));
    },
  );

  testWidgets('a finished job is read-only', (tester) async {
    final kit = await open(
      tester,
      arrange: (api) {
        api.chatCanSend = false;
        api.chatPeerMessage('job-1', 'Thank you');
      },
    );
    expect(find.text('Thank you'), findsOneWidget);
    expect(find.text('Chat is closed for this booking'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'welcome');
    await tester.tap(find.byKey(const Key('chat-send')));
    await _settle(tester);
    expect(kit.api.chatSent, isEmpty);
  });

  testWidgets('a booking that is not this worker\'s shows nothing', (
    tester,
  ) async {
    await open(tester, arrange: (api) => api.chatBookings.clear());
    expect(find.text('Could not load the conversation.'), findsOneWidget);
  });

  testWidgets('renders in Arabic', (tester) async {
    await open(
      tester,
      arabic: true,
      arrange: (api) => api.chatPeerMessage('job-1', 'مرحباً'),
    );
    expect(find.text('مرحباً'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'from a paid job the message button opens that job\'s conversation; before payment there is none',
    (tester) async {
      await open(
        tester,
        home: const ActiveJobScreen(jobId: 'job-1', mapsEnabled: false),
        arrange: (api) {
          api.workerJobList.add(job(paymentMethod: 'CASH'));
          api.chatPeerMessage('job-1', 'hello from the customer');
        },
      );
      await tester.tap(find.byKey(const Key('chat-button')));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(find.text('hello from the customer'), findsOneWidget);
      expect(find.text('Sara'), findsWidgets);

      await tester.pumpWidget(const SizedBox());
      await open(
        tester,
        home: const ActiveJobScreen(jobId: 'job-1', mapsEnabled: false),
        arrange: (api) => api.workerJobList.add(
          job(status: 'PAYMENT_PENDING', released: false),
        ),
      );
      expect(find.byKey(const Key('chat-button')), findsNothing);
    },
  );
}
