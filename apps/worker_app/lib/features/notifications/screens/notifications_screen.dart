import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

enum _Kind { ok, bad, warn }

/// The icon and colour of a notification, from what it is about.
(String, _Kind) _look(String type) => switch (type) {
  'request.new' => ('wrench', _Kind.ok),
  'quote.accepted' => ('check', _Kind.ok),
  'quote.rejected' => ('tag', _Kind.warn),
  'payment.confirmed' => ('card', _Kind.ok),
  'booking.cancelled' || 'booking.expired' => ('x', _Kind.bad),
  'chat.message' => ('message', _Kind.ok),
  'support.reply' => ('help', _Kind.ok),
  'verification.approved' ||
  'verification.reinstated' => ('verified', _Kind.ok),
  'verification.rejected' || 'verification.suspended' => ('alert', _Kind.bad),
  'verification.info_requested' => ('info', _Kind.warn),
  'admin.announcement' => ('gift', _Kind.warn),
  _ => ('bell', _Kind.ok),
};

/// "2 min", "3 h", "Yesterday", "5 Oct": how long ago, in the language of the app.
String _ago(DateTime at, bool ar, DateTime now) {
  final m = now.difference(at).inMinutes;
  if (m < 1) return ar ? 'الآن' : 'now';
  if (m < 60) return ar ? '$m د' : '$m min';
  if (m < 1440) return ar ? '${m ~/ 60} س' : '${m ~/ 60} h';
  final d = now.difference(at).inDays;
  if (d < 7) return ar ? '$d ي' : '$d d';
  final local = at.toUtc().add(const Duration(hours: 3));
  const en = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const ara = [
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
  ];
  return '${local.day} ${(ar ? ara : en)[local.month - 1]}';
}

bool _isToday(DateTime at, DateTime now) {
  final a = at.toUtc().add(const Duration(hours: 3));
  final b = now.toUtc().add(const Duration(hours: 3));
  return a.year == b.year && a.month == b.month && a.day == b.day;
}

/// The worker's notifications from the backend: new requests, decisions on quotes, payments, messages, support replies, decisions on the application and announcements.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, this.clock});

  /// For tests.
  final DateTime Function()? clock;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  NotificationsController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = JobsScope.of(context).notifications;
    if (!identical(next, _controller)) {
      _controller = next;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _controller!.load();
      });
    }
  }

  void _open(NotificationItem n) {
    final services = JobsScope.of(context);
    services.notifications.markRead(n);
    if (n.type == 'admin.announcement') return;
    services.openFromNotification(
      PushEvent(
        notificationId: n.id,
        type: n.type,
        resourceType: n.resourceType,
        resourceId: n.resourceId,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = _controller!;
    final ar = context.isAr;
    final now = (widget.clock ?? DateTime.now)();

    Widget header(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(2, 10, 2, 2),
      child: Text(
        ar ? text : text.toUpperCase(),
        style: ts(12, w: 700, c: AppColors.slate, ls: 0.72),
      ),
    );

    Widget item(NotificationItem n) {
      final (icon, kind) = _look(n.type);
      final (bg, fg) = switch (kind) {
        _Kind.bad => (AppColors.dangerBg, AppColors.danger),
        _Kind.warn => (AppColors.cream, const Color(0xFFB07A10)),
        _Kind.ok => (AppColors.tealTint, AppColors.primary),
      };
      return Tap(
        key: Key('notification-${n.id}'),
        onTap: () => _open(n),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: n.read ? const Color(0xFFFAFBFC) : Colors.white,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: AppColors.lineSoft),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(
                icon,
                size: 40,
                radius: 13,
                iconSize: 18,
                bg: bg,
                fg: fg,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Flexible(child: Text(n.title, style: ts(14.5, w: 600))),
                        const SizedBox(width: 8),
                        Text(
                          _ago(n.createdAt, ar, now),
                          style: ts(11.5, c: AppColors.slate),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(n.body, style: ts(13, c: AppColors.slate, h: 1.45)),
                  ],
                ),
              ),
              if (!n.read)
                Container(
                  key: Key('unread-${n.id}'),
                  width: 9,
                  height: 9,
                  margin: const EdgeInsetsDirectional.only(start: 12, top: 6),
                  decoration: const BoxDecoration(
                    color: AppColors.gold,
                    shape: BoxShape.circle,
                  ),
                ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final today = [
              for (final n in c.items)
                if (_isToday(n.createdAt, now)) n,
            ];
            final earlier = [
              for (final n in c.items)
                if (!_isToday(n.createdAt, now)) n,
            ];
            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
                  child: Row(
                    children: [
                      SquareIconButton.back(context),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          context.tr('notifications'),
                          style: ts(19, w: 700),
                        ),
                      ),
                      if (c.unread > 0)
                        Tap(
                          key: const Key('mark-all-read'),
                          onTap: c.markAllRead,
                          child: Text(
                            context.tr('markRead'),
                            style: ts(13.5, w: 600, c: AppColors.primary),
                          ),
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: RefreshIndicator(
                    onRefresh: c.load,
                    child: ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: EdgeInsets.fromLTRB(
                        20,
                        4,
                        20,
                        context.bottomInset + 20,
                      ),
                      children: [
                        if (c.status == FeedStatus.idle ||
                            c.status == FeedStatus.loading)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 60),
                            child: Center(
                              child: CircularProgressIndicator(
                                strokeWidth: 2.6,
                              ),
                            ),
                          )
                        else if (c.status == FeedStatus.failed)
                          EmptyState(
                            icon: 'bell',
                            title: context.tr('ntFailed'),
                            subtitle: '',
                            actionLabel: context.tr('retry'),
                            onAction: c.load,
                            verticalPadding: 60,
                          )
                        else if (c.items.isEmpty)
                          EmptyState(
                            icon: 'bell',
                            title: context.tr('ntNone'),
                            subtitle: context.tr('ntNoneSub'),
                            verticalPadding: 60,
                          )
                        else ...[
                          if (today.isNotEmpty) header(context.tr('ntToday')),
                          for (final n in today) ...[
                            const SizedBox(height: 8),
                            item(n),
                          ],
                          if (earlier.isNotEmpty) ...[
                            const SizedBox(height: 8),
                            header(context.tr('ntEarlier')),
                          ],
                          for (final n in earlier) ...[
                            const SizedBox(height: 8),
                            item(n),
                          ],
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
