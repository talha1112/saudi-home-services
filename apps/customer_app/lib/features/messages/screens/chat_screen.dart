import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart' as hs;
import 'package:url_launcher/url_launcher.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../tracking/widgets/tracking_sheets.dart';
import '../widgets/message_bubble.dart';
import '../widgets/chat_target.dart';

class _Seed {
  const _Seed({
    required this.mine,
    required this.text,
    required this.time,
    this.image = false,
    this.read = false,
  });
  final bool mine;
  final Bi text;
  final Bi time;
  final bool image;
  final bool read;
}

const _seed = [
  _Seed(
    mine: false,
    text: Bi(
      'Assalamu alaikum, I’m on my way. About 12 minutes.',
      'السلام عليكم، أنا في الطريق. حوالي 12 دقيقة.',
    ),
    time: Bi('5:48 PM', '5:48 م'),
  ),
  _Seed(
    mine: true,
    text: Bi(
      'Great. The building gate code is 4821.',
      'ممتاز. رمز بوابة العمارة 4821.',
    ),
    time: Bi('5:49 PM', '5:49 م'),
    read: true,
  ),
  _Seed(
    mine: false,
    image: true,
    text: Bi('Is this the right unit?', 'هل هذه الوحدة الصحيحة؟'),
    time: Bi('5:51 PM', '5:51 م'),
  ),
];

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, this.target});

  /// The real conversation to show; without one this is the prototype chat (demo builds only).
  final ChatTarget? target;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
  final _draft = TextEditingController();
  final _scroll = ScrollController();
  final List<ChatMessage> _extra = [];
  Timer? _reply;

  hs.ChatController? _chat;
  int _shown = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final t = widget.target;
    if (t != null && _chat == null) {
      final auth = context.authRead;
      _chat = t.support
          ? hs.ChatController(
              auth: auth,
              transport: hs.SupportChatTransport(auth.api),
            )
          : hs.ChatController(
              api: auth.api,
              auth: auth,
              bookingId: t.bookingId,
            );
      _chat!.start();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _chat?.setForeground(state == AppLifecycleState.resumed);
  }

  /// "5:52 PM" in Saudi time, whatever the phone's time zone.
  String _clock(DateTime? at) {
    if (at == null) return '';
    final t = at.toUtc().add(const Duration(hours: 3));
    final h12 = t.hour % 12 == 0 ? 12 : t.hour % 12;
    final suffix = t.hour < 12
        ? (context.isAr ? 'ص' : 'AM')
        : (context.isAr ? 'م' : 'PM');
    return '$h12:${t.minute.toString().padLeft(2, '0')} $suffix';
  }

  List<ChatMessage> _realMessages(hs.ChatController chat) => [
    for (final m in chat.messages)
      ChatMessage(
        mine: m.fromMe,
        text: m.body,
        time: switch (m.delivery) {
          hs.ChatDelivery.failed => context.tr('chatFailed'),
          hs.ChatDelivery.sending => context.tr('chatSending'),
          _ => _clock(m.createdAt),
        },
        read: m.delivery == hs.ChatDelivery.read,
      ),
  ];

  /// Failed messages are retried by tapping them (their label says so).
  void _retryFailed(int index) {
    final chat = _chat;
    if (chat == null) return;
    final m = chat.messages[index];
    if (m.delivery == hs.ChatDelivery.failed) chat.retry(m.clientMessageId);
  }

  Future<void> _sendReal(String text) async {
    final chat = _chat!;
    final messenger = ScaffoldMessenger.of(context);
    final ok = await chat.send(text);
    if (!mounted) return;
    if (ok) {
      _draft.clear();
      return;
    }
    final key = switch (chat.problem) {
      hs.ChatProblem.closed => 'chatClosed',
      hs.ChatProblem.tooLong => 'chatTooLong',
      hs.ChatProblem.rateLimited => 'chatRate',
      hs.ChatProblem.network => 'chatNetwork',
      hs.ChatProblem.notSignedIn => 'chatSignIn',
      hs.ChatProblem.notAvailable => 'chatGone',
      hs.ChatProblem.empty || null => null,
      hs.ChatProblem.other => 'chatOther',
    };
    if (key != null) {
      messenger.showSnackBar(SnackBar(content: Text(context.tr(key))));
    }
    // a message that only failed on the network stays in the box's history as "tap to retry"; the draft was already moved there
    if (chat.problem == hs.ChatProblem.network) _draft.clear();
  }

  void _afterBuildScroll(int count) {
    if (count == _shown) return;
    _shown = count;
    _scrollToEnd();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _chat?.dispose();
    _reply?.cancel();
    _draft.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _draft.text.trim();
    if (text.isEmpty) return;
    final ar = context.isAr;
    _draft.clear();
    setState(
      () => _extra.add(
        ChatMessage(mine: true, text: text, time: ar ? '5:52 م' : '5:52 PM'),
      ),
    );
    _scrollToEnd();
    _reply?.cancel();
    _reply = Timer(const Duration(milliseconds: 1400), () {
      if (!mounted) return;
      setState(() {
        for (var i = 0; i < _extra.length; i++) {
          if (_extra[i].mine) _extra[i] = _extra[i].copyWith(read: true);
        }
        _extra.add(
          ChatMessage(
            mine: false,
            text: ar ? 'تم، شكراً لك.' : 'Noted, thank you.',
            time: ar ? '5:53 م' : '5:53 PM',
          ),
        );
      });
      _scrollToEnd();
    });
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _submit() {
    if (_chat != null) {
      _sendReal(_draft.text);
    } else {
      _send();
    }
  }

  String _initial(String name) => name.trim().isEmpty
      ? '•'
      : String.fromCharCode(name.trim().runes.first).toUpperCase();

  @override
  Widget build(BuildContext context) {
    final chat = _chat;
    if (chat == null) return _content(context, null);
    return ListenableBuilder(
      listenable: chat,
      builder: (context, _) => _content(context, chat),
    );
  }

  Widget _content(BuildContext context, hs.ChatController? chat) {
    final target = widget.target;
    final app = context.app;
    if (chat != null) _afterBuildScroll(chat.messages.length);
    final worker = target == null ? app.worker : null;
    final messages = chat != null
        ? _realMessages(chat)
        : [
            for (final m in _seed)
              ChatMessage(
                mine: m.mine,
                text: context.l(m.text),
                time: context.l(m.time),
                image: m.image,
                read: m.read,
              ),
            ..._extra,
          ];
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(bottom: BorderSide(color: AppColors.lineSoft)),
              ),
              child: Row(
                children: [
                  SquareIconButton.back(context),
                  const SizedBox(width: 12),
                  InitialsTile(
                    target != null
                        ? _initial(target.peerName)
                        : context.l(worker!.initials),
                    size: 42,
                    fontSize: 16,
                    radius: 14,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                target?.peerName ?? context.l(worker!.name),
                                style: ts(15, w: 600),
                              ),
                            ),
                            const SizedBox(width: 5),
                            const AppIcon(
                              'verified',
                              size: 14,
                              color: AppColors.primary,
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: const BoxDecoration(
                                color: AppColors.primary,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 5),
                            Text(
                              target?.subtitle ??
                                  context.l(kStages[app.stage].label),
                              style: ts(12, c: AppColors.primary),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  if (target == null || (target.peerPhone ?? '').isNotEmpty)
                    SquareIconButton(
                      key: const Key('chat-call'),
                      icon: 'phone',
                      iconSize: 19,
                      bg: AppColors.tealTint,
                      fg: AppColors.primary,
                      bordered: false,
                      onTap: () => target == null
                          ? showCallSheet(context)
                          : launchUrl(
                              Uri(scheme: 'tel', path: target.peerPhone),
                            ),
                    ),
                  const SizedBox(width: 12),
                  const SizedBox(
                    width: 36,
                    height: 44,
                    child: Center(
                      child: AppIcon('more', size: 20, color: AppColors.slate),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
                children: [
                  Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEEF2F4),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        context.tr('today'),
                        style: ts(12, c: AppColors.slate),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 290),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const AppIcon(
                            'shield',
                            size: 14,
                            color: AppColors.primary,
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              context.tr('chatSafe'),
                              textAlign: TextAlign.center,
                              style: ts(12, c: AppColors.slate, h: 1.45),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (chat != null && messages.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text(
                          chat.status == hs.ChatStatus.failed
                              ? context.tr('chatLoadFailed')
                              : (chat.status == hs.ChatStatus.loading
                                    ? ''
                                    : context.tr(
                                        target?.support == true
                                            ? 'chatEmptySupport'
                                            : 'chatEmptyReal',
                                      )),
                          key: const Key('chat-empty'),
                          style: ts(13, c: AppColors.slate),
                        ),
                      ),
                    ),
                  for (var i = 0; i < messages.length; i++) ...[
                    chat != null
                        ? Tap(
                            key: Key('msg-$i'),
                            onTap: () => _retryFailed(i),
                            child: MessageBubble(message: messages[i]),
                          )
                        : MessageBubble(message: messages[i]),
                    const SizedBox(height: 10),
                  ],
                ],
              ),
            ),
            Container(
              padding: EdgeInsets.fromLTRB(
                16,
                10,
                16,
                context.bottomInset > 0 ? 6 : 12,
              ),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(top: BorderSide(color: AppColors.lineSoft)),
              ),
              child: Row(
                children: [
                  const SquareIconButton(
                    icon: 'camera',
                    iconSize: 20,
                    bg: AppColors.chip,
                    fg: AppColors.slate,
                    bordered: false,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Container(
                      height: 46,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppColors.background,
                        borderRadius: BorderRadius.circular(15),
                        border: Border.all(color: AppColors.line, width: 1.5),
                      ),
                      child: BareField(
                        controller: _draft,
                        key: const Key('chat-input'),
                        hint:
                            chat != null &&
                                !chat.canSend &&
                                chat.status == hs.ChatStatus.ready
                            ? context.tr('chatClosed')
                            : context.tr('typeMsg'),
                        onSubmitted: (_) => _submit(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Tap(
                    key: const Key('chat-send'),
                    onTap: _submit,
                    child: Container(
                      width: 46,
                      height: 46,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppColors.primary,
                        borderRadius: BorderRadius.circular(15),
                      ),
                      child: Transform.flip(
                        flipX: context.isAr,
                        child: const AppIcon(
                          'send',
                          size: 19,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
