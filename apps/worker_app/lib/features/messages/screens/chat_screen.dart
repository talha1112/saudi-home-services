import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart' as hs;
import 'package:url_launcher/url_launcher.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../../jobs/widgets/call_sheet.dart';
import '../widgets/message_bubble.dart';
import '../widgets/chat_target.dart';

class _Seed {
  const _Seed(this.mine, this.text, this.time, {this.image = false});
  final bool mine;
  final Bi text;
  final Bi time;
  final bool image;
}

const _seed = [
  _Seed(
    false,
    Bi(
      'Hi Faisal, the gate code is 4821. Parking is in front of building 12.',
      'مرحباً فيصل، رمز البوابة 4821. الموقف أمام مبنى 12.',
    ),
    Bi('5:49 PM', '5:49 م'),
  ),
  _Seed(
    true,
    Bi(
      'Thanks, I’ll be there in about 12 minutes.',
      'شكراً، سأصل خلال 12 دقيقة تقريباً.',
    ),
    Bi('5:50 PM', '5:50 م'),
  ),
  _Seed(
    false,
    Bi('This is the unit that’s dripping.', 'هذه الوحدة التي تسرّب.'),
    Bi('5:51 PM', '5:51 م'),
    image: true,
  ),
];

const _quick = [
  Bi('On my way', 'في الطريق'),
  Bi('I’ve arrived', 'وصلت'),
  Bi('Running 10 min late', 'سأتأخر 10 دقائق'),
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

  void _afterBuildScroll(int count) {
    if (count == _shown) return;
    _shown = count;
    _scrollToEnd();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _chat?.dispose();
    _draft.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send(String text) {
    final v = text.trim();
    if (v.isEmpty) return;
    _draft.clear();
    setState(
      () => _extra.add(
        ChatMessage(
          mine: true,
          text: v,
          time: context.isAr ? '5:52 م' : '5:52 PM',
        ),
      ),
    );
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

  void _submit(String text) {
    if (_chat != null) {
      _sendReal(text);
    } else {
      _send(text);
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
    if (chat != null) _afterBuildScroll(chat.messages.length);
    final r = target == null ? context.app.request : null;
    final messages = chat != null
        ? _realMessages(chat)
        : [
            for (final m in _seed)
              ChatMessage(
                mine: m.mine,
                text: context.l(m.text),
                time: context.l(m.time),
                image: m.image,
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
                        : context.l(r!.initial),
                    size: 42,
                    fontSize: 16,
                    radius: 14,
                    bg: AppColors.chip,
                    fg: AppColors.text,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          target?.peerName ?? context.l(r!.customer),
                          style: ts(15, w: 600),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          target?.subtitle ?? context.l(r!.service),
                          style: ts(12, c: AppColors.slate),
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
                ],
              ),
            ),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.all(16),
                children: [
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
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (target?.support != true) ...[
                    SizedBox(
                      height: 32,
                      child: ListView(
                        scrollDirection: Axis.horizontal,
                        children: [
                          for (final q in _quick) ...[
                            Tap(
                              onTap: () => _submit(context.l(q)),
                              child: Container(
                                height: 32,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                ),
                                alignment: Alignment.center,
                                decoration: BoxDecoration(
                                  color: const Color(0xFFF3F8F7),
                                  borderRadius: BorderRadius.circular(16),
                                  border: Border.all(
                                    color: AppColors.tealSoftBorder,
                                  ),
                                ),
                                child: Text(
                                  context.l(q),
                                  style: ts(12.5, w: 600, c: AppColors.primary),
                                ),
                              ),
                            ),
                            const SizedBox(width: 6),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  Row(
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
                            border: Border.all(
                              color: AppColors.line,
                              width: 1.5,
                            ),
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
                            onSubmitted: _submit,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Tap(
                        key: const Key('chat-send'),
                        onTap: () => _submit(_draft.text),
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
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
