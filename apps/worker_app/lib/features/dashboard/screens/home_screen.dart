import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/home_widgets.dart';
import '../widgets/real_home.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    // The prototype below (invented name, earnings, ratings, requests and schedule) is shown in demo builds only.
    if (!kDemoData) return RealHome(active: app.tab == 0);
    final ar = context.isAr;
    final requests = [
      for (var i = 0; i < kRequests.length; i++)
        if (i > 0 || app.quoteState == QuoteState.none) kRequests[i],
    ];
    final r = app.request;
    final accepted = app.quoteAccepted;
    final pending = app.quoteState == QuoteState.pending;
    final firstStatus = accepted
        ? (ar ? 'مقبول' : 'Accepted')
        : (pending
              ? (ar ? 'بانتظار العميل' : 'Quoted')
              : (ar ? 'بحاجة لعرض' : 'Needs quote'));
    return ListView(
      padding: const EdgeInsets.only(top: 4, bottom: 28),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 0),
          child: Row(
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  InitialsTile(
                    ar ? 'ف' : 'FH',
                    size: 48,
                    fontSize: 16,
                    radius: 16,
                  ),
                  PositionedDirectional(
                    bottom: -3,
                    end: -3,
                    child: Container(
                      width: 20,
                      height: 20,
                      alignment: Alignment.center,
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                      ),
                      child: const AppIcon(
                        'verified',
                        size: 16,
                        color: AppColors.primary,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      context.tr('hello'),
                      style: ts(13.5, c: AppColors.slate),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      ar ? 'فيصل الحربي' : 'Faisal Al-Harbi',
                      style: ts(19, w: 700),
                    ),
                  ],
                ),
              ),
              Stack(
                clipBehavior: Clip.none,
                children: [
                  SquareIconButton(
                    icon: 'bell',
                    size: 46,
                    radius: 15,
                    iconSize: 21,
                    onTap: () => AppRouter.toNotifications(context),
                  ),
                  PositionedDirectional(
                    top: -4,
                    end: -4,
                    child: Container(
                      constraints: const BoxConstraints(minWidth: 20),
                      height: 20,
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppColors.gold,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: AppColors.background,
                          width: 2,
                        ),
                      ),
                      child: Text(
                        '3',
                        style: ts(11, w: 800, family: kLatinFont),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
          child: OnlineToggleCard(
            online: app.online,
            onTap: () => app.update(() => app.online = !app.online),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: StatTile(
                    icon: 'card',
                    iconColor: AppColors.primary,
                    value: context.sar(255),
                    label: ar ? 'أرباح اليوم' : 'Today’s net',
                    onTap: () => app.showTab(2, period: 0),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: StatTile(
                    icon: 'star',
                    iconColor: AppColors.gold,
                    filled: true,
                    value: '4.9',
                    label: ar ? '318 تقييماً' : '318 reviews',
                    onTap: () => app.showTab(3),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: StatTile(
                    icon: 'wrench',
                    iconColor: AppColors.primary,
                    value: '2',
                    label: ar ? 'مهام اليوم' : 'Jobs today',
                    onTap: () => app.showTab(1, jobs: 2),
                  ),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Text(context.tr('newRequests'), style: ts(18, w: 700)),
                  const SizedBox(width: 8),
                  Container(
                    constraints: const BoxConstraints(minWidth: 22),
                    height: 22,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: AppColors.gold,
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: Text(
                      '${requests.length}',
                      style: ts(12, w: 800, family: kLatinFont),
                    ),
                  ),
                ],
              ),
              Tap(
                onTap: () => app.showTab(1, jobs: 0),
                child: Text(
                  context.tr('seeAll'),
                  style: ts(14, w: 600, c: AppColors.primary),
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            children: [
              for (final req in requests) ...[
                RequestCard(
                  request: req,
                  onOpen: () => AppRouter.toRequest(context),
                ),
                const SizedBox(height: 12),
              ],
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
          child: Text(context.tr('todaySchedule'), style: ts(18, w: 700)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            children: [
              ScheduleRow(
                time: '4:00',
                ampm: ar ? 'م' : 'PM',
                service: ar ? 'تعبئة غاز المكيف' : 'AC Gas Refill',
                subtitle: ar ? 'خالد ن. · الملقا' : 'Khalid N. · Al Malqa',
                status: ar ? 'مكتمل' : 'Done',
                statusBg: const Color(0xFFEEF2F4),
                statusFg: const Color(0xFF334155),
                onTap: () => app.showTab(1, jobs: 4),
              ),
              const SizedBox(height: 10),
              ScheduleRow(
                time: '6:00',
                ampm: ar ? 'م' : 'PM',
                service: context.l(r.service),
                subtitle: '${context.l(r.customer)} · ${context.l(r.area)}',
                status: firstStatus,
                statusBg: accepted ? AppColors.tealTint : AppColors.cream,
                statusFg: accepted ? AppColors.primary : AppColors.creamText,
                onTap: () {
                  if (accepted) {
                    AppRouter.toActive(context);
                  } else if (pending) {
                    AppRouter.toQuoteStatus(context);
                  } else {
                    AppRouter.toRequest(context);
                  }
                },
              ),
            ],
          ),
        ),
      ],
    );
  }
}
