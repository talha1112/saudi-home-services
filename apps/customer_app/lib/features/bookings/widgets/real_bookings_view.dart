import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/booking_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tiles.dart';
import '../../booking/logic/booking_schedule.dart';
import '../my_bookings_controller.dart';

/// Which of the four tabs a backend state belongs to.
int bookingTabFor(String status) => switch (status) {
  'IN_PROGRESS' => 1,
  'COMPLETED' => 2,
  'CANCELLED' || 'EXPIRED' => 3,
  _ =>
    0, // OPEN, PAYMENT_PENDING, CONFIRMED and anything new: still ahead of the customer
};

/// The signed-in customer's own bookings, as the backend returns them. Loading, empty and failed states are all explicit.
class RealBookingsView extends StatefulWidget {
  const RealBookingsView({
    super.key,
    required this.tabLabels,
    required this.selected,
    required this.onTab,
    required this.active,
  });

  /// Whether the Bookings tab is the one on screen. The tab shell keeps every tab alive, so this is how the list knows to refresh.
  final bool active;

  final List<String> tabLabels;
  final int selected;
  final ValueChanged<int> onTab;

  @override
  State<RealBookingsView> createState() => _RealBookingsViewState();
}

class _RealBookingsViewState extends State<RealBookingsView> {
  MyBookingsController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final controller = BookingScope.of(context).bookings;
    if (!identical(controller, _controller)) {
      _controller = controller;
      if (widget.active) _refresh();
    }
  }

  @override
  void didUpdateWidget(RealBookingsView old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _refresh();
  }

  void _refresh() {
    final controller = _controller;
    if (controller == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) controller.load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller!;
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final groups = List.generate(4, (_) => <BookingSummary>[]);
        for (final b in controller.items) {
          groups[bookingTabFor(b.status)].add(b);
        }
        final list = groups[widget.selected];
        final loadingFirst =
            controller.status == MyBookingsStatus.idle ||
            (controller.status == MyBookingsStatus.loading &&
                controller.items.isEmpty);
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text(context.tr('myBookings'), style: ts(26, w: 700)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: SegmentedTabs(
                labels: widget.tabLabels,
                selected: widget.selected,
                badges: [for (final g in groups) g.length],
                onChanged: widget.onTab,
              ),
            ),
            if (controller.error != null && controller.items.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                child: Text(
                  context.tr('bkRefreshFailed'),
                  key: const Key('bookings-refresh-failed'),
                  style: ts(12.5, c: AppColors.slate),
                ),
              ),
            Expanded(
              child: loadingFirst
                  ? const Center(
                      child: CircularProgressIndicator(strokeWidth: 2.6),
                    )
                  : controller.status == MyBookingsStatus.failed
                  ? _Failed(onRetry: controller.load)
                  : RefreshIndicator(
                      onRefresh: controller.load,
                      child: ListView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
                        children: [
                          for (final b in list) ...[
                            _BookingRow(booking: b),
                            const SizedBox(height: 12),
                          ],
                          if (list.isEmpty)
                            EmptyState(
                              icon: 'calendar',
                              title: context.tr('bkEmpty'),
                              subtitle: context.tr('bkEmptySub'),
                              tileBg: const Color(0xFFEEF2F4),
                              tileFg: const Color(0xFF64748B),
                              verticalPadding: 60,
                            ),
                        ],
                      ),
                    ),
            ),
          ],
        );
      },
    );
  }
}

class _Failed extends StatelessWidget {
  const _Failed({required this.onRetry});
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              context.tr('bkLoadFailed'),
              key: const Key('bookings-failed'),
              textAlign: TextAlign.center,
              style: ts(15, c: AppColors.slate),
            ),
            const SizedBox(height: 14),
            AppButton(
              key: const Key('bookings-retry'),
              label: context.tr('retry'),
              expand: false,
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 22),
              onPressed: onRetry,
            ),
          ],
        ),
      ),
    );
  }
}

class _BookingRow extends StatelessWidget {
  const _BookingRow({required this.booking});
  final BookingSummary booking;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final start = booking.preferredStartAt;
    final status = 'status${booking.status}';
    final statusText = context.tr(status) == status
        ? booking.status
        : context.tr(status);
    final when = start == null
        ? ''
        : bookingWhenLabel(start, ar: ar, urgent: booking.isUrgent);
    return AppCard(
      key: Key('booking-${booking.id}'),
      onTap: () => AppRouter.toBookingDetail(context, booking.id),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IconTile('calendar', size: 46, radius: 15, iconSize: 21),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(booking.serviceName(arabic: ar), style: ts(15, w: 600)),
                if (when.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(when, style: ts(12.5, c: AppColors.slate)),
                ],
                if (booking.reference.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    booking.reference,
                    style: ts(12, c: AppColors.slate, family: kLatinFont),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 8),
          Pill(statusText, bg: AppColors.tealTint, fg: AppColors.primary),
        ],
      ),
    );
  }
}

String bookingWhenLabel(
  DateTime start, {
  required bool ar,
  required bool urgent,
}) {
  final local = saudiNow(start);
  final h12 = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final mm = local.minute.toString().padLeft(2, '0');
  final suffix = local.hour < 12 ? (ar ? 'ص' : 'AM') : (ar ? 'م' : 'PM');
  final today = saudiNow(DateTime.now().toUtc());
  final isToday =
      local.year == today.year &&
      local.month == today.month &&
      local.day == today.day;
  final day = isToday
      ? (ar ? 'اليوم' : 'Today')
      : '${weekdayName(local.weekday, arabic: ar)} ${local.day}/${local.month}';
  return '$day · $h12:$mm $suffix';
}
