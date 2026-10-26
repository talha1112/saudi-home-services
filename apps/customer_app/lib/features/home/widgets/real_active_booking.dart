import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/booking_scope.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';
import '../../bookings/my_bookings_controller.dart';
import '../../bookings/widgets/real_bookings_view.dart';

/// The customer's paid booking that is coming up or under way, at the top of Home: from the server's own list. Nothing is shown when
/// there is none.
class RealActiveBooking extends StatefulWidget {
  const RealActiveBooking({super.key});

  @override
  State<RealActiveBooking> createState() => _RealActiveBookingState();
}

class _RealActiveBookingState extends State<RealActiveBooking> {
  MyBookingsController? _c;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = BookingScope.of(context).bookings;
    if (!identical(next, _c)) {
      _c = next;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && context.auth.isSignedIn) _c!.load();
      });
    }
  }

  /// In progress first, then the soonest paid one.
  BookingSummary? _pick(List<BookingSummary> all) {
    final live = [
      for (final b in all)
        if (b.status == 'IN_PROGRESS' || b.status == 'CONFIRMED') b,
    ];
    if (live.isEmpty) return null;
    live.sort((a, b) {
      if ((a.status == 'IN_PROGRESS') != (b.status == 'IN_PROGRESS')) {
        return a.status == 'IN_PROGRESS' ? -1 : 1;
      }
      final x = a.preferredStartAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      final y = b.preferredStartAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      return x.compareTo(y);
    });
    return live.first;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _c!,
      builder: (context, _) {
        final b = _pick(_c!.items);
        if (b == null) return const SizedBox.shrink();
        final ar = context.isAr;
        final soft = Colors.white.withValues(alpha: .85);
        final start = b.preferredStartAt;
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
          child: ClipRRect(
            key: const Key('home-active-booking'),
            borderRadius: BorderRadius.circular(24),
            child: Container(
              color: AppColors.primary,
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Flexible(
                        child: Text(
                          ar
                              ? context.tr('activeBooking')
                              : context.tr('activeBooking').toUpperCase(),
                          style: ts(12, w: 700, c: soft, ls: 0.72),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 5,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .14),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: const BoxDecoration(
                                color: AppColors.gold,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              context.tr('status${b.status}'),
                              style: ts(12.5, w: 600, c: Colors.white),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Text(
                    b.serviceName(arabic: ar),
                    style: ts(19, w: 700, c: Colors.white),
                  ),
                  if (start != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      bookingWhenLabel(start, ar: ar, urgent: b.isUrgent),
                      style: ts(13.5, c: soft),
                    ),
                  ],
                  const SizedBox(height: 16),
                  AppButton(
                    key: const Key('home-active-open'),
                    label: context.tr('track'),
                    kind: AppButtonKind.gold,
                    height: 46,
                    radius: 15,
                    onPressed: () => AppRouter.toBookingDetail(context, b.id),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
