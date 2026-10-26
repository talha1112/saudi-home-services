import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h) =>
    HsApi(baseUrl: 'https://api.example.com/api/v1', client: MockClient(h), clock: () => DateTime.utc(2026, 11, 1));
http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, dynamic> _msg(int seq, {bool mine = false, String? status, String body = 'hello'}) => {
  'id': 'm-$seq',
  'bookingId': 'b-1',
  'seq': seq,
  'senderRole': mine ? 'CUSTOMER' : 'WORKER',
  'clientMessageId': 'cm-$seq-xxxxxxxx',
  'body': body,
  'createdAt': '2026-11-01T10:0$seq:00.000Z',
  'fromMe': mine,
  'status': ?status,
};

void main() {
  group('the API calls', () {
    test('history: path, token, afterSeq, and the parsed page with the server\'s delivery marks', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {
          'items': [_msg(1), _msg(2, mine: true, status: 'READ'), _msg(3, mine: true, status: 'DELIVERED'), _msg(4, mine: true, status: 'SENT')],
          'meta': {
            'limit': 50,
            'hasMore': false,
            'direction': 'forward',
            'lastSeq': 4,
            'canSend': true,
            'receipts': {
              'mine': {'deliveredUpToSeq': 1, 'readUpToSeq': 1},
              'other': {'deliveredUpToSeq': 3, 'readUpToSeq': 2},
            },
          },
        });
      });
      final page = await api.chatMessages('tok', 'b-1', afterSeq: 0);

      expect(seen.url.path, '/api/v1/bookings/b-1/messages');
      expect(seen.url.queryParameters['afterSeq'], '0');
      expect(seen.headers['Authorization'], 'Bearer tok');
      expect(page.canSend, isTrue);
      expect(page.lastSeq, 4);
      expect(page.items.map((m) => m.fromMe), [false, true, true, true]);
      expect(page.items.map((m) => m.delivery), [ChatDelivery.sent, ChatDelivery.read, ChatDelivery.delivered, ChatDelivery.sent]);
      expect(page.items.first.createdAt, DateTime.utc(2026, 11, 1, 10, 1));
      expect(page.otherReadUpToSeq, 2);
    });

    test('sending posts only the client id and the text, and the answer is my message', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(201, {..._msg(5), 'duplicate': false});
      });
      final m = await api.sendChatMessage('tok', 'b-1', clientMessageId: 'cm-abc12345', body: 'On my way');

      expect(seen.method, 'POST');
      expect(seen.url.path, '/api/v1/bookings/b-1/messages');
      expect(jsonDecode(seen.body), {'clientMessageId': 'cm-abc12345', 'body': 'On my way'}, reason: 'no sender, role or booking in the body');
      expect(m.fromMe, isTrue);
      expect(m.seq, 5);
    });

    test('a closed chat is a 409 CHAT_CLOSED; a stranger gets 404', () async {
      var n = 0;
      final api = _api(
        (r) async => n++ == 0
            ? _json(409, {'statusCode': 409, 'code': 'CHAT_CLOSED', 'message': 'closed'})
            : _json(404, {'statusCode': 404, 'code': 'NOT_FOUND'}),
      );
      await expectLater(
        api.sendChatMessage('t', 'b', clientMessageId: 'cm-12345678', body: 'x'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'CHAT_CLOSED')),
      );
      await expectLater(api.chatMessages('t', 'b'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });

    test('receipts post the kind and the highest seq', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {'deliveredUpToSeq': 3, 'readUpToSeq': 3});
      });
      await api.chatReceipt('tok', 'b-1', kind: 'READ', upToSeq: 3);
      expect(seen.url.path, '/api/v1/bookings/b-1/messages/receipts');
      expect(jsonDecode(seen.body), {'kind': 'READ', 'upToSeq': 3});
    });
  });

  group('the conversation', () {
    late TestHsClient kit;
    late ChatController chat;
    var ids = 0;

    Future<void> setUpChat({bool signedIn = true}) async {
      kit = TestHsClient();
      if (signedIn) {
        await kit.client.auth.sendCode('+966551234567');
        await kit.client.auth.submitCode('123456');
      }
      kit.api.chatBookings.add('b-1');
      ids = 0;
      chat = ChatController(api: kit.api, auth: kit.client.auth, bookingId: 'b-1', pollInterval: Duration.zero, newId: () => 'client-msg-${++ids}');
      addTearDown(() {
        chat.dispose();
        kit.client.auth.dispose();
      });
    }

    test('loads the history, oldest first, and says whether messages can be sent', () async {
      await setUpChat();
      kit.api.chatPeerMessage('b-1', 'Assalamu alaikum');
      kit.api.chatPeerMessage('b-1', 'I am on my way');
      await chat.start();

      expect(chat.status, ChatStatus.ready);
      expect(chat.messages.map((m) => m.body), ['Assalamu alaikum', 'I am on my way']);
      expect(chat.messages.every((m) => !m.fromMe), isTrue);
      expect(chat.canSend, isTrue);
    });

    test('a chat the person is not part of fails as not available, with nothing shown', () async {
      await setUpChat();
      kit.api.chatBookings.clear();
      await chat.start();
      expect(chat.status, ChatStatus.failed);
      expect(chat.error!.status, 404);
      expect(chat.messages, isEmpty);
    });

    test('my message appears at once, is confirmed with its server number, and what the other side sent is picked up on refresh', () async {
      await setUpChat();
      await chat.start();

      final sending = chat.send('  Gate code is 4821  ');
      expect(chat.messages.single.delivery, ChatDelivery.sending);
      expect(await sending, isTrue);

      expect(chat.messages.single.body, 'Gate code is 4821');
      expect(chat.messages.single.seq, 1);
      expect(chat.messages.single.delivery, ChatDelivery.sent);
      expect(kit.api.chatSent, ['client-msg-1']);

      kit.api.chatPeerMessage('b-1', 'Thanks');
      await chat.refresh();
      expect(chat.messages.map((m) => m.body), ['Gate code is 4821', 'Thanks']);
      expect(chat.messages.map((m) => m.fromMe), [true, false]);
    });

    test('refresh never duplicates a message that was already shown', () async {
      await setUpChat();
      await chat.start();
      await chat.send('one');
      await chat.refresh();
      await chat.refresh();
      expect(chat.messages, hasLength(1));
    });

    test('an empty message is not sent', () async {
      await setUpChat();
      await chat.start();
      expect(await chat.send('   '), isFalse);
      expect(chat.problem, ChatProblem.empty);
      expect(kit.api.chatSent, isEmpty);
      expect(chat.messages, isEmpty);
    });

    test('a closed chat sends nothing and says so; the history stays readable', () async {
      await setUpChat();
      kit.api.chatCanSend = false;
      kit.api.chatPeerMessage('b-1', 'See you');
      await chat.start();
      expect(chat.canSend, isFalse);
      expect(await chat.send('hello?'), isFalse);
      expect(chat.problem, ChatProblem.closed);
      expect(kit.api.chatSent, isEmpty);
      expect(chat.messages.single.body, 'See you');
    });

    test('the server closing the chat meanwhile removes the unsent message and closes the box', () async {
      await setUpChat();
      await chat.start();
      kit.api.chatCanSend = false; // the booking finished after the last refresh
      expect(await chat.send('late message'), isFalse);
      expect(chat.problem, ChatProblem.closed);
      expect(chat.messages, isEmpty, reason: 'it was refused, not stored');
      expect(chat.canSend, isFalse);
    });

    test('no connection keeps the message as failed; retry sends the SAME client id, so the server stores it once', () async {
      await setUpChat();
      await chat.start();
      kit.api.chatSendResult = const ApiException(status: 0, code: 'NETWORK');
      expect(await chat.send('hello'), isFalse);
      expect(chat.messages.single.delivery, ChatDelivery.failed);
      expect(chat.problem, ChatProblem.network);

      kit.api.chatSendResult = null;
      await chat.retry('client-msg-1');
      expect(chat.messages.single.delivery, ChatDelivery.sent);
      expect(kit.api.chatSent, ['client-msg-1', 'client-msg-1']);
      expect(kit.api.chatStore['b-1'], hasLength(1), reason: 'one message on the server');
    });

    test('the answer was lost but the server stored the message: the retry returns it, still one message', () async {
      await setUpChat();
      await chat.start();
      // the server stores it, the answer never arrives
      kit.api.chatStore['b-1'] = [
        ChatMessage(id: 's1', clientMessageId: 'client-msg-1', body: 'hi', fromMe: true, delivery: ChatDelivery.sent, seq: 1),
      ];
      kit.api.chatSendResult = const ApiException(status: 0, code: 'NETWORK');
      await chat.send('hi');
      kit.api.chatSendResult = null;
      await chat.retry('client-msg-1');
      await chat.refresh();
      expect(chat.messages, hasLength(1));
      expect(chat.messages.single.seq, 1);
    });

    test('ticks follow what the other side has read', () async {
      await setUpChat();
      await chat.start();
      await chat.send('one');
      await chat.send('two');
      kit.api.chatOtherRead = 1;
      kit.api.chatPeerMessage('b-1', 'ok'); // makes the refresh return something new
      await chat.refresh();
      final mine = chat.messages.where((m) => m.fromMe).toList();
      expect(mine[0].delivery, ChatDelivery.read);
      expect(mine[1].delivery, ChatDelivery.sent);
    });

    test('incoming messages are reported as read while the screen is on top, and not while it is away', () async {
      await setUpChat();
      kit.api.chatPeerMessage('b-1', 'a');
      kit.api.chatPeerMessage('b-1', 'b');
      chat.setForeground(false);
      await chat.start();
      expect(kit.api.chatReceipts, isEmpty);

      chat.setForeground(true);
      await Future<void>.delayed(Duration.zero);
      expect(kit.api.chatReceipts, [('READ', 2)]);
      await chat.refresh();
      expect(kit.api.chatReceipts, hasLength(1), reason: 'not reported again until something newer arrives');
    });

    test('a refresh that fails keeps the conversation', () async {
      await setUpChat();
      kit.api.chatPeerMessage('b-1', 'a');
      await chat.start();
      kit.api.chatListResult = const ApiException(status: 0, code: 'NETWORK');
      await chat.refresh();
      expect(chat.status, ChatStatus.ready);
      expect(chat.messages, hasLength(1));
    });

    test('signed out: nothing is requested', () async {
      await setUpChat(signedIn: false);
      await chat.start();
      expect(chat.status, ChatStatus.failed);
      expect(kit.api.calls, isNot(contains('chatMessages')));
    });

    test('the controller polls while open and stops when disposed', () async {
      final k = TestHsClient();
      await k.client.auth.sendCode('+966551234567');
      await k.client.auth.submitCode('123456');
      k.api.chatBookings.add('b-1');
      final c = ChatController(api: k.api, auth: k.client.auth, bookingId: 'b-1', pollInterval: const Duration(milliseconds: 20));
      await c.start();
      k.api.chatPeerMessage('b-1', 'later');
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(c.messages.map((m) => m.body), ['later']);
      c.dispose();
      final calls = k.api.calls.where((x) => x == 'chatMessages').length;
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(k.api.calls.where((x) => x == 'chatMessages').length, calls);
      k.client.auth.dispose();
    });
  });

  group('support', () {
    test('the support API: path, token, polling cursor, and a send carries only the client id and the text', () async {
      final seen = <http.Request>[];
      final api = _api((r) async {
        seen.add(r);
        return r.method == 'GET'
            ? _json(200, {
                'items': [
                  _msg(1, mine: true),
                  {..._msg(2), 'senderRole': 'ADMIN'},
                ],
                'meta': {'limit': 100, 'hasMore': false, 'lastSeq': 2, 'canSend': true, 'status': 'ANSWERED'},
              })
            : _json(201, {..._msg(3), 'duplicate': false});
      });
      final page = await api.supportMessages('tok', afterSeq: 0);
      expect(seen[0].url.path, '/api/v1/support/messages');
      expect(seen[0].url.queryParameters['afterSeq'], '0');
      expect(seen[0].headers['Authorization'], 'Bearer tok');
      expect(page.canSend, isTrue);
      expect(page.items.map((m) => m.fromMe), [true, false]);

      final sent = await api.sendSupportMessage('tok', clientMessageId: 'cm-12345678', body: 'help');
      expect(seen[1].method, 'POST');
      expect(seen[1].url.path, '/api/v1/support/messages');
      expect(jsonDecode(seen[1].body), {'clientMessageId': 'cm-12345678', 'body': 'help'});
      expect(sent.fromMe, isTrue);
    });

    test('the controller works over the support transport: first message starts the conversation, the administrator reply arrives', () async {
      final kit = TestHsClient();
      await kit.client.auth.sendCode('+966551234567');
      await kit.client.auth.submitCode('123456');
      final chat = ChatController(
        auth: kit.client.auth,
        transport: SupportChatTransport(kit.api),
        pollInterval: Duration.zero,
        newId: () => 'support-msg-1',
      );
      addTearDown(() {
        chat.dispose();
        kit.client.auth.dispose();
      });
      await chat.start();
      expect(chat.status, ChatStatus.ready);
      expect(chat.canSend, isTrue, reason: 'a conversation can always be written to');
      expect(chat.messages, isEmpty);

      expect(await chat.send('My application was rejected'), isTrue);
      expect(kit.api.supportStore.single.body, 'My application was rejected');

      kit.api.supportAdminReply('Please re-upload your ID.');
      await chat.refresh();
      expect(chat.messages.map((m) => (m.fromMe, m.body)), [(true, 'My application was rejected'), (false, 'Please re-upload your ID.')]);
      expect(kit.api.calls, isNot(contains('chatReceipt')), reason: 'support has no read receipts');
    });
  });
}
