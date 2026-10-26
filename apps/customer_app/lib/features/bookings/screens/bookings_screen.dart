import 'package:flutter/material.dart';

import '../../../app/app_state.dart';
import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/models/service.dart';
import '../widgets/booking_card.dart';
import '../widgets/real_bookings_view.dart';

const _tabLabels = [
  Bi('Upcoming', 'القادمة'),
  Bi('Active', 'النشطة'),
  Bi('Done', 'المكتملة'),
  Bi('Cancelled', 'الملغاة'),
];

class BookingsScreen extends StatelessWidget {
  const BookingsScreen({super.key});

  BookingEntry _entry(
    BuildContext context, {
    required Service service,
    required String date,
    required Worker worker,
    required String status,
    required BookingBadge badge,
    required int amount,
    String? primaryLabel,
    VoidCallback? onPrimary,
    bool primaryFilled = false,
    String? rating,
    bool invoice = false,
  }) {
    return BookingEntry(
      icon: service.icon,
      name: context.l(service.name),
      date: date,
      worker: context.l(worker.name),
      workerInitials: context.l(worker.initials),
      status: status,
      badge: badge,
      amount: context.sar(amount),
      primaryLabel: primaryLabel ?? context.tr('viewDetails'),
      onPrimary: onPrimary ?? () {},
      primaryFilled: primaryFilled,
      rating: rating,
      secondaryLabel: invoice ? context.tr('invoice') : null,
      onSecondary: invoice ? () => AppRouter.toInvoice(context) : null,
    );
  }

  List<List<BookingEntry>> _build(BuildContext context, AppState app) {
    final ar = context.isAr;
    final leak = serviceById('leak');
    final light = serviceById('light');
    final socket = serviceById('socket');
    final when = app.whenLabel(ar);

    return [
      // Upcoming
      [
        _entry(
          context,
          service: socket,
          date: ar ? 'السبت 10 أكتوبر · 4:00 م' : 'Sat 10 Oct · 4:00 PM',
          worker: kWorkers[2],
          status: ar ? 'مؤكد' : 'Confirmed',
          badge: BookingBadge.neutral,
          amount: 114,
        ),
      ],
      // Active
      if (app.hasActive || (!app.cancelled && !app.isDone))
        [
          _entry(
            context,
            service: app.service,
            date: when,
            worker: app.worker,
            status: context.l(kStages[app.stage].label),
            badge: BookingBadge.active,
            amount: app.total,
            primaryLabel: context.tr('trackWorker'),
            onPrimary: () => AppRouter.toTrack(context),
            primaryFilled: true,
          ),
        ]
      else
        <BookingEntry>[],
      // Done
      [
        _entry(
          context,
          service: leak,
          date: ar ? '21 سبتمبر 2026' : '21 Sep 2026',
          worker: kWorkers[1],
          status: ar ? 'مكتمل' : 'Completed',
          badge: BookingBadge.neutral,
          amount: 184,
          rating: '5.0',
          invoice: true,
          primaryLabel: context.tr('bookAgain'),
          onPrimary: () => AppRouter.toBooking(context, serviceId: 'leak'),
        ),
        _entry(
          context,
          service: light,
          date: ar ? '2 سبتمبر 2026' : '2 Sep 2026',
          worker: kWorkers[2],
          status: ar ? 'مكتمل' : 'Completed',
          badge: BookingBadge.neutral,
          amount: 149,
          rating: '4.0',
          invoice: true,
          primaryLabel: context.tr('bookAgain'),
          onPrimary: () => AppRouter.toBooking(context, serviceId: 'light'),
        ),
        if (app.isDone)
          _entry(
            context,
            service: app.service,
            date: context.tr('today'),
            worker: app.worker,
            status: ar ? 'مكتمل' : 'Completed',
            badge: BookingBadge.neutral,
            amount: app.total,
            invoice: true,
            primaryLabel: context.tr('rateNow'),
            onPrimary: () => AppRouter.toRate(context),
          ),
      ],
      // Cancelled
      if (app.cancelled)
        [
          _entry(
            context,
            service: app.service,
            date: when,
            worker: app.worker,
            status: ar ? 'الاسترداد قيد المعالجة' : 'Refund pending',
            badge: BookingBadge.warning,
            amount: app.total - (app.stage >= 3 ? kMinCharge : 0),
            primaryLabel: context.tr('trackRefund'),
          ),
        ]
      else
        <BookingEntry>[],
    ];
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    if (!kDemoData) {
      return RealBookingsView(
        tabLabels: [for (final l in _tabLabels) context.l(l)],
        selected: app.bookingsTab,
        active: app.tab == 1,
        onTab: (i) => app.showTab(app.tab, bookings: i),
      );
    }
    final groups = _build(context, app);
    final selected = app.bookingsTab;
    final list = groups[selected];
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
            labels: [for (final l in _tabLabels) context.l(l)],
            selected: selected,
            badges: [for (var i = 0; i < 4; i++) i < 2 ? groups[i].length : 0],
            onChanged: (i) => app.showTab(app.tab, bookings: i),
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
            children: [
              for (final e in list) ...[
                BookingCard(entry: e),
                const SizedBox(height: 12),
              ],
              if (list.isEmpty)
                EmptyState(
                  icon: 'calendar',
                  title: context.tr('emptyB'),
                  subtitle: context.tr('emptyBSub'),
                  tileBg: const Color(0xFFEEF2F4),
                  tileFg: const Color(0xFF64748B),
                  verticalPadding: 60,
                ),
            ],
          ),
        ),
      ],
    );
  }
}
