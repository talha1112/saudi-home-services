import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/features/bookings/screens/booking_detail_screen.dart';
import 'package:customer_app/features/messages/screens/chat_screen.dart';
import 'package:customer_app/features/messages/widgets/chat_target.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

import 'support/booking_harness.dart';

/// The customer's side of the booking chat, through the real screen on the shared fake backend. The screen is the prototype's, unchanged;
/// what changed is that its messages come from, and go to, `/bookings/:id/messages`.
const _target = ChatTarget(
  bookingId: 'b-1',
  peerName: 'Faisal Al-Harbi',
  subtitle: 'AC repair',
  peerPhone: '+966500000001',
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

void main() {
  if (kDemoData) return;
  setUpAll(loadAppFonts);

  Future<TestHsClient> open(
    WidgetTester tester, {
    ChatTarget target = _target,
    bool arabic = false,
    void Function(FakeApi)? arrange,
    Widget? home,
  }) async {
    phoneSize(tester, height: 1000);
    final kit = TestHsClient();
    await signIn(kit);
    kit.api.chatBookings.add('b-1');
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
        home: home ?? ChatScreen(target: target),
      ),
    );
    await _settle(tester);
    return kit;
  }

  testWidgets('shows the real conversation and none of the prototype\'s', (
    tester,
  ) async {
    await open(
      tester,
      arrange: (api) {
        api.chatPeerMessage('b-1', 'Assalamu alaikum, on my way');
        api.chatStore['b-1']!.add(
          ChatMessage(
            id: 's2',
            clientMessageId: 'cm-mine-0001',
            body: 'Gate code is 4821',
            fromMe: true,
            delivery: ChatDelivery.sent,
            seq: 2,
            createdAt: DateTime.now().toUtc(),
          ),
        );
      },
    );
    expect(find.text('Assalamu alaikum, on my way'), findsOneWidget);
    expect(find.text('Gate code is 4821'), findsOneWidget);
    expect(find.text('Great. The building gate code is 4821.'), findsNothing);
    expect(find.text('Faisal Al-Harbi'), findsOneWidget);
    expect(find.text('AC repair'), findsOneWidget);
  });

  testWidgets('a conversation with no messages says so', (tester) async {
    await open(tester);
    expect(find.byKey(const Key('chat-empty')), findsOneWidget);
    expect(find.text('No messages yet. Say hello.'), findsOneWidget);
  });

  testWidgets(
    'typing and sending stores the message on the backend, shows it, and clears the box',
    (tester) async {
      final kit = await open(tester);
      await tester.enterText(find.byType(TextField), '  See you at 6  ');
      await tester.tap(find.byKey(const Key('chat-send')));
      await _settle(tester);

      expect(kit.api.chatStore['b-1']!.single.body, 'See you at 6');
      expect(find.text('See you at 6'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
    },
  );

  testWidgets(
    'what the professional writes appears without leaving the screen',
    (tester) async {
      final kit = await open(tester);
      kit.api.chatPeerMessage('b-1', 'I have arrived');
      await tester.pump(const Duration(seconds: 4));
      await _settle(tester);
      expect(find.text('I have arrived'), findsOneWidget);
      expect(
        kit.api.chatReceipts,
        isNotEmpty,
        reason: 'it is reported as read while the screen is open',
      );
    },
  );

  testWidgets(
    'a message that fails on the network says so; tapping it sends the same message once',
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
      expect(
        find.text('No connection. Your message was not sent.'),
        findsOneWidget,
      );

      kit.api.chatSendResult = null;
      await tester.tap(find.byKey(const Key('msg-0')));
      await _settle(tester);
      expect(find.text('Not sent. Tap to retry'), findsNothing);
      expect(kit.api.chatStore['b-1'], hasLength(1));
      expect(
        kit.api.chatSent.toSet(),
        hasLength(1),
        reason: 'both attempts carried the same client id',
      );
    },
  );

  testWidgets(
    'a closed chat keeps the history readable, says it is closed, and sends nothing',
    (tester) async {
      final kit = await open(
        tester,
        arrange: (api) {
          api.chatCanSend = false;
          api.chatPeerMessage('b-1', 'Job done, thank you');
        },
      );
      expect(find.text('Job done, thank you'), findsOneWidget);
      expect(find.text('Chat is closed for this booking'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'one more thing');
      await tester.tap(find.byKey(const Key('chat-send')));
      await _settle(tester);
      expect(kit.api.chatSent, isEmpty);
      expect(
        find.byKey(const Key('msg-1')),
        findsNothing,
        reason: 'no bubble was added (the words stay in the box)',
      );
    },
  );

  testWidgets(
    'a conversation the person may not see shows nothing and does not send',
    (tester) async {
      final kit = await open(
        tester,
        arrange: (api) => api.chatBookings.clear(),
      );
      expect(find.byKey(const Key('chat-empty')), findsOneWidget);
      expect(find.text('Could not load the conversation.'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'hi');
      await tester.tap(find.byKey(const Key('chat-send')));
      await _settle(tester);
      expect(
        kit.api.chatSent,
        isEmpty,
        reason: 'the chat is closed until the server says it can send',
      );
    },
  );

  testWidgets('the call button appears only when the phone was released', (
    tester,
  ) async {
    await open(tester);
    expect(find.byKey(const Key('chat-call')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await open(
      tester,
      target: const ChatTarget(
        bookingId: 'b-1',
        peerName: 'Faisal',
        subtitle: 'AC repair',
      ),
    );
    expect(find.byKey(const Key('chat-call')), findsNothing);
  });

  testWidgets('renders in Arabic', (tester) async {
    await open(
      tester,
      arabic: true,
      arrange: (api) => api.chatPeerMessage('b-1', 'مرحباً'),
    );
    expect(find.text('مرحباً'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'from a paid booking the chat button opens that booking\'s conversation',
    (tester) async {
      final kit = await open(
        tester,
        home: const BookingDetailScreen(bookingId: 'b-1'),
        arrange: (api) {
          api.chatPeerMessage('b-1', 'hello from the professional');
          api.detailStore['b-1'] = BookingDetail(
            id: 'b-1',
            reference: 'HS-1',
            status: 'CONFIRMED',
            serviceNameEn: 'AC repair',
            serviceNameAr: 'إصلاح',
            location: const BookingLocation(cityId: 'c'),
            isUrgent: false,
            problemDescription: 'x',
            worker: const AssignedWorker(
              workerId: 'w',
              fullName: 'Faisal',
              phone: '+966500000001',
            ),
            paymentMethod: 'CASH',
          );
        },
      );
      await tester.tap(find.byKey(const Key('chat-button')));
      await _settle(tester);
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(find.text('hello from the professional'), findsOneWidget);
      expect(find.text('Faisal'), findsWidgets);
      expect(kit.api.calls, contains('chatMessages'));
    },
  );

  testWidgets('there is no chat button before the booking is paid', (
    tester,
  ) async {
    await open(
      tester,
      home: const BookingDetailScreen(bookingId: 'b-1'),
      arrange: (api) => api.detailStore['b-1'] = BookingDetail(
        id: 'b-1',
        reference: 'HS-1',
        status: 'PAYMENT_PENDING',
        serviceNameEn: 'AC repair',
        serviceNameAr: 'إصلاح',
        location: const BookingLocation(cityId: 'c'),
        isUrgent: false,
        problemDescription: 'x',
        worker: const AssignedWorker(workerId: 'w', fullName: 'Faisal'),
      ),
    );
    expect(find.byKey(const Key('chat-button')), findsNothing);
  });
}
