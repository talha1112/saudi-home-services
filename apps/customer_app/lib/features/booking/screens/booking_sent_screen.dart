import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../logic/booking_schedule.dart';

/// Shown after the backend created the request. Everything on it comes from the backend's response: the reference, the status and the
/// requested window. No payment is taken at this point: the backend only asks for payment after the customer accepts a quote.
class BookingSentScreen extends StatelessWidget {
  const BookingSentScreen({super.key, required this.booking});

  final BookingView booking;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final start = booking.preferredStartAt;
    final end = booking.preferredEndAt;
    final rows = <(String, String)>[
      if (booking.reference.isNotEmpty)
        (context.tr('sentRef'), booking.reference),
      (context.tr('sentStatus'), _statusText(context, booking.status)),
      if (start != null)
        (context.tr('sentWhen'), _windowText(start, end, arabic: ar)),
    ];
    return PopScope(
      canPop: false,
      child: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 48, 20, 24),
                  children: [
                    Center(
                      child: Container(
                        width: 88,
                        height: 88,
                        alignment: Alignment.center,
                        decoration: const BoxDecoration(
                          color: AppColors.tealTint,
                          shape: BoxShape.circle,
                        ),
                        child: const AppIcon(
                          'check',
                          size: 40,
                          color: AppColors.primary,
                          strokeWidth: 2.6,
                        ),
                      ),
                    ),
                    const SizedBox(height: 22),
                    Text(
                      context.tr('sentTitle'),
                      key: const Key('sent-title'),
                      textAlign: TextAlign.center,
                      style: ts(24, w: 700),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      context.tr('sentSub'),
                      textAlign: TextAlign.center,
                      style: ts(14.5, c: AppColors.slate, h: 1.55),
                    ),
                    const SizedBox(height: 24),
                    AppCard(
                      padding: const EdgeInsets.all(16),
                      radius: 18,
                      child: Column(
                        children: [
                          for (var i = 0; i < rows.length; i++) ...[
                            if (i > 0) const SizedBox(height: 12),
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  rows[i].$1,
                                  style: ts(13.5, c: AppColors.slate),
                                ),
                                const SizedBox(width: 16),
                                Expanded(
                                  child: Text(
                                    rows[i].$2,
                                    textAlign: TextAlign.end,
                                    style: ts(14, w: 600),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              BottomBar(
                child: Column(
                  children: [
                    AppButton(
                      key: const Key('view-bookings'),
                      label: context.tr('viewBookings'),
                      onPressed: () => AppRouter.toBookingsTab(context, tab: 0),
                    ),
                    const SizedBox(height: 10),
                    AppButton(
                      key: const Key('back-home'),
                      label: context.tr('backHome'),
                      kind: AppButtonKind.soft,
                      onPressed: () => AppRouter.toHomeTab(context),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The backend's state name in the customer's words; an unknown state is shown as the backend sent it rather than hidden.
String _statusText(BuildContext context, String status) {
  final key = 'status$status';
  return context.tr(key) == key ? status : context.tr(key);
}

/// "Today · 6:00 PM – 8:00 PM", in Saudi time.
String _windowText(DateTime start, DateTime? end, {required bool arabic}) {
  String clock(DateTime utc) {
    final local = saudiNow(utc);
    final h12 = local.hour % 12 == 0 ? 12 : local.hour % 12;
    final mm = local.minute.toString().padLeft(2, '0');
    final suffix = local.hour < 12
        ? (arabic ? 'ص' : 'AM')
        : (arabic ? 'م' : 'PM');
    return '$h12:$mm $suffix';
  }

  final local = saudiNow(start);
  final today = saudiNow(DateTime.now().toUtc());
  final isToday =
      local.year == today.year &&
      local.month == today.month &&
      local.day == today.day;
  final day = isToday
      ? (arabic ? 'اليوم' : 'Today')
      : '${weekdayName(local.weekday, arabic: arabic)} ${local.day}/${local.month}';
  final range = end == null ? clock(start) : '${clock(start)} – ${clock(end)}';
  return '$day · $range';
}
