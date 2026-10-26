/// Booking chat between the customer and the worker assigned to the booking (`/bookings/:bookingId/messages`).
///
/// The backend keeps every message (PostgreSQL), numbers them per booking (`seq`, never reused) and accepts a send only while the booking
/// is CONFIRMED or IN_PROGRESS; the history stays readable afterwards. The sender and role always come from the sign-in, never from the
/// request. This file holds the shapes and the controller both apps share.
library;

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'errors.dart';

enum ChatDelivery { sending, failed, sent, delivered, read }

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.clientMessageId,
    required this.body,
    required this.fromMe,
    required this.delivery,
    this.seq,
    this.createdAt,
  });

  /// A message of the history / a send answer. [fromMe] is whether the signed-in person sent it.
  factory ChatMessage.fromJson(Map<String, dynamic> json, {bool? fromMe}) {
    final mine = fromMe ?? json['fromMe'] as bool? ?? false;
    final status = json['status'] as String?;
    return ChatMessage(
      id: json['id'] as String? ?? json['clientMessageId'] as String? ?? '',
      clientMessageId: json['clientMessageId'] as String? ?? '',
      body: json['body'] as String? ?? '',
      fromMe: mine,
      seq: (json['seq'] as num?)?.toInt(),
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? ''),
      delivery: !mine
          ? ChatDelivery.sent
          : switch (status) {
              'READ' => ChatDelivery.read,
              'DELIVERED' => ChatDelivery.delivered,
              _ => ChatDelivery.sent,
            },
    );
  }

  final String id;

  /// Chosen by the app per message and reused on a retry, so a retry can never create a second message.
  final String clientMessageId;
  final String body;
  final bool fromMe;
  final ChatDelivery delivery;
  final int? seq;
  final DateTime? createdAt;

  bool get isPending => delivery == ChatDelivery.sending || delivery == ChatDelivery.failed;

  ChatMessage withDelivery(ChatDelivery d) =>
      ChatMessage(id: id, clientMessageId: clientMessageId, body: body, fromMe: fromMe, delivery: d, seq: seq, createdAt: createdAt);
}

class ChatPage {
  const ChatPage({
    required this.items,
    required this.lastSeq,
    required this.canSend,
    required this.hasMore,
    this.otherReadUpToSeq = 0,
    this.otherDeliveredUpToSeq = 0,
  });

  factory ChatPage.fromJson(Map<String, dynamic> json) {
    final meta = json['meta'] as Map<String, dynamic>? ?? const {};
    final receipts = meta['receipts'] as Map<String, dynamic>? ?? const {};
    final other = receipts['other'] as Map<String, dynamic>? ?? const {};
    return ChatPage(
      items: [for (final i in (json['items'] as List<dynamic>? ?? const [])) ChatMessage.fromJson(i as Map<String, dynamic>)],
      lastSeq: (meta['lastSeq'] as num?)?.toInt() ?? 0,
      canSend: meta['canSend'] as bool? ?? false,
      hasMore: meta['hasMore'] as bool? ?? false,
      otherReadUpToSeq: (other['readUpToSeq'] as num?)?.toInt() ?? 0,
      otherDeliveredUpToSeq: (other['deliveredUpToSeq'] as num?)?.toInt() ?? 0,
    );
  }

  final List<ChatMessage> items;
  final int lastSeq;

  /// Whether the booking is in a state that accepts new messages.
  final bool canSend;
  final bool hasMore;
  final int otherReadUpToSeq;
  final int otherDeliveredUpToSeq;
}

/// Where a conversation's messages live. The same controller and screen serve a booking chat and the support chat.
abstract class ChatTransport {
  Future<ChatPage> fetch(String accessToken, {int? afterSeq, int limit = 100});
  Future<ChatMessage> send(String accessToken, {required String clientMessageId, required String body});

  /// Reports messages up to [upToSeq] as read. Support conversations have no receipts and do nothing.
  Future<void> markRead(String accessToken, int upToSeq);
}

/// The chat of one booking, between its customer and its assigned worker.
class BookingChatTransport implements ChatTransport {
  const BookingChatTransport(this.api, this.bookingId);
  final HsApi api;
  final String bookingId;

  @override
  Future<ChatPage> fetch(String accessToken, {int? afterSeq, int limit = 100}) =>
      api.chatMessages(accessToken, bookingId, afterSeq: afterSeq, limit: limit);

  @override
  Future<ChatMessage> send(String accessToken, {required String clientMessageId, required String body}) =>
      api.sendChatMessage(accessToken, bookingId, clientMessageId: clientMessageId, body: body);

  @override
  Future<void> markRead(String accessToken, int upToSeq) => api.chatReceipt(accessToken, bookingId, kind: 'READ', upToSeq: upToSeq);
}

/// The signed-in person's conversation with the administrators (`/support/messages`). It always accepts messages; the first one starts it.
class SupportChatTransport implements ChatTransport {
  const SupportChatTransport(this.api);
  final HsApi api;

  @override
  Future<ChatPage> fetch(String accessToken, {int? afterSeq, int limit = 100}) => api.supportMessages(accessToken, afterSeq: afterSeq, limit: limit);

  @override
  Future<ChatMessage> send(String accessToken, {required String clientMessageId, required String body}) =>
      api.sendSupportMessage(accessToken, clientMessageId: clientMessageId, body: body);

  @override
  Future<void> markRead(String accessToken, int upToSeq) async {}
}

enum ChatStatus { loading, ready, failed }

/// Why the last send did not go through.
enum ChatProblem { closed, tooLong, empty, rateLimited, network, notSignedIn, notAvailable, other }

/// One booking's conversation: loads the history, keeps it current, sends, and reports what was read.
///
/// New messages arrive by asking for everything after the last known `seq` every [pollInterval] while the screen is open (REST; the
/// backend's socket channel is an optional speed-up and is not needed for correctness: history is the source of truth). Sending is
/// retry-safe: each message carries a `clientMessageId`, the same one on every retry, so the server stores it once.
class ChatController extends ChangeNotifier {
  /// A booking chat (`api` + `bookingId`) or any other conversation (`transport`).
  ChatController({
    required this.auth,
    HsApi? api,
    String? bookingId,
    ChatTransport? transport,
    this.pollInterval = const Duration(seconds: 3),
    String Function()? newId,
  }) : assert(transport != null || (api != null && bookingId != null), 'give a transport, or an api and a booking id'),
       transport = transport ?? BookingChatTransport(api!, bookingId!),
       _newId = newId ?? _randomId;

  final AuthController auth;
  final ChatTransport transport;
  final Duration pollInterval;
  final String Function() _newId;

  ChatStatus _status = ChatStatus.loading;
  final List<ChatMessage> _messages = [];
  bool _canSend = false;
  int _lastSeq = 0;
  int _readReported = 0;
  ChatProblem? _problem;
  ApiException? _error;
  Timer? _timer;
  Future<void>? _polling;
  bool _disposed = false;
  bool _foreground = true;
  final Map<String, Future<void>> _sending = {};

  ChatStatus get status => _status;
  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get canSend => _canSend;
  ChatProblem? get problem => _problem;
  ApiException? get error => _error;

  /// Loads the latest page and starts keeping it current.
  Future<void> start() async {
    await _load(initial: true);
    _timer?.cancel();
    if (pollInterval > Duration.zero && !_disposed) {
      _timer = Timer.periodic(pollInterval, (_) => refresh());
    }
  }

  /// Asks for anything newer. Calls while one is running share it. Failures are quiet: the next tick tries again.
  Future<void> refresh() => _polling ??= _load(initial: false).whenComplete(() => _polling = null);

  /// Whether the screen is on top; messages are reported as read only then.
  void setForeground(bool value) {
    _foreground = value;
    if (value) unawaited(_report());
  }

  Future<void> _load({required bool initial}) async {
    try {
      final after = initial ? null : _lastSeq;
      final page = await auth.authorized((t) => transport.fetch(t, afterSeq: after, limit: 100));
      _error = null;
      _merge(page);
      if (initial) _status = ChatStatus.ready;
      // a gap larger than one page: keep fetching until caught up
      if (!initial && page.hasMore) unawaited(refresh());
    } on ApiException catch (e) {
      _error = e;
      if (initial && _messages.isEmpty) _status = ChatStatus.failed;
    }
    _notify();
    unawaited(_report());
  }

  void _merge(ChatPage page) {
    _canSend = page.canSend;
    for (final m in page.items) {
      var sent = m;
      if (m.fromMe && m.seq != null) {
        // what the other side has seen decides the tick, even if the server did not mark it on this message
        if (m.seq! <= page.otherReadUpToSeq) {
          sent = m.withDelivery(ChatDelivery.read);
        } else if (m.seq! <= page.otherDeliveredUpToSeq && m.delivery == ChatDelivery.sent) {
          sent = m.withDelivery(ChatDelivery.delivered);
        }
      }
      final i = _messages.indexWhere((x) => x.clientMessageId == m.clientMessageId);
      if (i >= 0) {
        _messages[i] = sent;
      } else {
        _messages.add(sent);
      }
    }
    // keep the history in the server's order; messages still being sent stay at the end in the order they were typed
    final confirmed = _messages.where((m) => m.seq != null).toList()..sort((a, b) => a.seq!.compareTo(b.seq!));
    final pending = _messages.where((m) => m.seq == null).toList();
    _messages
      ..clear()
      ..addAll(confirmed)
      ..addAll(pending);
    // what the other side has seen applies to every message of mine, not only the ones that came with this page
    for (var i = 0; i < _messages.length; i++) {
      final m = _messages[i];
      if (!m.fromMe || m.seq == null || m.delivery == ChatDelivery.read) continue;
      if (m.seq! <= page.otherReadUpToSeq) {
        _messages[i] = m.withDelivery(ChatDelivery.read);
      } else if (m.seq! <= page.otherDeliveredUpToSeq && m.delivery == ChatDelivery.sent) {
        _messages[i] = m.withDelivery(ChatDelivery.delivered);
      }
    }
    _lastSeq = max(_lastSeq, page.lastSeq);
  }

  /// Sends [text]. Returns false (with [problem] set) when nothing was sent; a send that fails on the network stays in the list as
  /// [ChatDelivery.failed] and [retry] sends the same message again without risk of a duplicate.
  Future<bool> send(String text) async {
    final body = text.trim();
    _problem = null;
    if (body.isEmpty) {
      _problem = ChatProblem.empty;
      _notify();
      return false;
    }
    if (!_canSend) {
      _problem = ChatProblem.closed;
      _notify();
      return false;
    }
    final id = _newId();
    _messages.add(ChatMessage(id: id, clientMessageId: id, body: body, fromMe: true, delivery: ChatDelivery.sending));
    _notify();
    await _transmit(id, body);
    return _messages.any((m) => m.clientMessageId == id && !m.isPending);
  }

  /// Sends a failed message again (same `clientMessageId`).
  Future<void> retry(String clientMessageId) async {
    final i = _messages.indexWhere((m) => m.clientMessageId == clientMessageId && m.delivery == ChatDelivery.failed);
    if (i < 0) return;
    final m = _messages[i];
    _messages[i] = m.withDelivery(ChatDelivery.sending);
    _problem = null;
    _notify();
    await _transmit(clientMessageId, m.body);
  }

  Future<void> _transmit(String id, String body) {
    final running = _sending[id];
    if (running != null) return running;
    final future = _doTransmit(id, body).whenComplete(() {
      _sending.remove(id);
    });
    _sending[id] = future;
    return future;
  }

  Future<void> _doTransmit(String id, String body) async {
    try {
      final stored = await auth.authorized((t) => transport.send(t, clientMessageId: id, body: body));
      final i = _messages.indexWhere((m) => m.clientMessageId == id);
      if (i >= 0) _messages[i] = stored;
      if (stored.seq != null) _lastSeq = max(_lastSeq, stored.seq!);
      final confirmed = _messages.where((m) => m.seq != null).toList()..sort((a, b) => a.seq!.compareTo(b.seq!));
      final pending = _messages.where((m) => m.seq == null).toList();
      _messages
        ..clear()
        ..addAll(confirmed)
        ..addAll(pending);
    } on ApiException catch (e) {
      final i = _messages.indexWhere((m) => m.clientMessageId == id);
      final definitive = e.status != 0 && e.status < 500 && e.status != 429;
      if (definitive) {
        // refused (chat closed, too long...): it was not stored and retrying the same text will not help
        if (i >= 0) _messages.removeAt(i);
        _problem = _classify(e);
        if (e.code == 'CHAT_CLOSED') _canSend = false;
      } else {
        if (i >= 0) _messages[i] = _messages[i].withDelivery(ChatDelivery.failed);
        _problem = _classify(e);
      }
    }
    _notify();
  }

  Future<void> _report() async {
    if (!_foreground || _disposed) return;
    final upTo = _messages.where((m) => !m.fromMe && m.seq != null).fold<int>(0, (a, m) => max(a, m.seq!));
    if (upTo <= _readReported) return;
    try {
      await auth.authorized((t) => transport.markRead(t, upTo));
      _readReported = upTo;
    } on ApiException {
      // reported again on the next refresh
    }
  }

  ChatProblem _classify(ApiException e) {
    if (e.status == 0) return ChatProblem.network;
    if (e.isUnauthorized || e.code == 'NO_SESSION') return ChatProblem.notSignedIn;
    switch (e.code) {
      case 'CHAT_CLOSED':
        return ChatProblem.closed;
      case 'MESSAGE_TOO_LONG':
        return ChatProblem.tooLong;
      case 'MESSAGE_EMPTY':
        return ChatProblem.empty;
      case 'RATE_LIMITED':
        return ChatProblem.rateLimited;
    }
    if (e.status == 404 || e.status == 403) return ChatProblem.notAvailable;
    if (e.status == 429) return ChatProblem.rateLimited;
    return ChatProblem.other;
  }

  void clearProblem() {
    if (_problem == null) return;
    _problem = null;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }

  static String _randomId() {
    final r = Random.secure();
    return 'm${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}${List.generate(8, (_) => r.nextInt(36).toRadixString(36)).join()}';
  }
}
