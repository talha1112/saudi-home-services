import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/ribbons.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/min_charge_card.dart';

class ServiceDetailsScreen extends StatelessWidget {
  const ServiceDetailsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final service = app.service;
    final top = MediaQuery.paddingOf(context).top;
    return Scaffold(
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                _Hero(top: top),
                Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(context.l(service.name), style: ts(24, w: 700)),
                      const SizedBox(height: 8),
                      if (service.rating != null ||
                          service.duration != null) ...[
                        Row(
                          children: [
                            if (service.rating != null)
                              RatingInline(
                                rating: service.rating!.toStringAsFixed(1),
                                trailing: service.reviews == null
                                    ? ''
                                    : ' (${service.reviews} ${context.tr('reviews')})',
                                size: 15,
                                fontSize: 13.5,
                              ),
                            if (service.duration != null) ...[
                              const SizedBox(width: 12),
                              const AppIcon(
                                'clock',
                                size: 14,
                                color: AppColors.slate,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                context.l(service.duration!),
                                style: ts(13.5, c: AppColors.slate),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 8),
                      ],
                      Text(
                        context.l(service.description),
                        style: ts(15, c: AppColors.slate, h: 1.55),
                      ),
                      // Everything below is prototype content (fake pro counts, inclusions, reviews, policies): demo builds only.
                      if (kDemoData) ...[
                        const SizedBox(height: 20),
                        const _ProsNearCard(),
                        const SizedBox(height: 20),
                        Text(context.tr('included'), style: ts(17, w: 700)),
                        const SizedBox(height: 12),
                        for (final item
                            in kIncluded[service.category] ?? const []) ...[
                          Row(
                            children: [
                              const IconTile(
                                'check',
                                size: 24,
                                radius: 8,
                                iconSize: 14,
                                strokeWidth: 2.6,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(context.l(item), style: ts(14.5)),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                        ],
                        const SizedBox(height: 8),
                        const MinChargeCard(),
                        const SizedBox(height: 20),
                        const _AvailableDates(),
                        const SizedBox(height: 20),
                        const _ReviewsSection(),
                        const SizedBox(height: 20),
                        const _PolicyCards(),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          BottomBar(
            child: Row(
              children: [
                if (service.price != null) ...[
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('minFrom'),
                        style: ts(12, c: AppColors.slate),
                      ),
                      const SizedBox(height: 1),
                      Text(context.sar(service.price!), style: ts(20, w: 700)),
                    ],
                  ),
                  const SizedBox(width: 16),
                ],
                Expanded(
                  child: AppButton(
                    label: context.tr('bookService'),
                    onPressed: () =>
                        AppRouter.toBooking(context, serviceId: service.id),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.top});
  final double top;

  @override
  Widget build(BuildContext context) {
    final service = context.app.service;
    return Container(
      height: 210 + top,
      color: AppColors.tealTint,
      child: ClipRect(
        child: Stack(
          alignment: Alignment.center,
          children: [
            Padding(
              padding: EdgeInsets.only(top: top),
              child: Container(
                width: 300,
                height: 300,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0x0F00695C), width: 40),
                ),
              ),
            ),
            Padding(
              padding: EdgeInsets.only(top: top),
              child: Container(
                width: 104,
                height: 104,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(32),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x2600695C),
                      blurRadius: 36,
                      offset: Offset(0, 16),
                    ),
                  ],
                ),
                child: AppIcon(
                  service.icon,
                  size: 48,
                  color: AppColors.primary,
                  strokeWidth: 1.8,
                ),
              ),
            ),
            PositionedDirectional(
              top: top + 6,
              start: 20,
              child: SquareIconButton.back(context, bordered: false),
            ),
            if (service.ribbon != null)
              CornerRibbon(
                context.l(service.ribbon!),
                top: top + 24,
                end: -38,
                width: 150,
                vertical: 6,
                fontSize: 11.5,
                bg: service.ribbonGold ? AppColors.gold : AppColors.primary,
                fg: service.ribbonGold ? AppColors.text : Colors.white,
                shadow: true,
              ),
          ],
        ),
      ),
    );
  }
}

class _ProsNearCard extends StatelessWidget {
  const _ProsNearCard();

  @override
  Widget build(BuildContext context) {
    Widget avatar(
      String text,
      Color bg,
      Color fg, {
      double fs = 12,
      bool first = false,
      String? family,
    }) {
      return Container(
        width: 34,
        height: 34,
        margin: EdgeInsetsDirectional.only(start: first ? 0 : 24),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: bg,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 2),
        ),
        child: Text(
          text,
          style: ts(fs, w: 700, c: fg, family: family),
        ),
      );
    }

    return AppCard(
      padding: const EdgeInsets.all(14),
      radius: 18,
      child: Row(
        children: [
          SizedBox(
            width: 34 + 24 * 2,
            height: 34,
            child: Stack(
              children: [
                avatar(
                  context.l(kWorkers[0].initials),
                  AppColors.tealTint,
                  AppColors.primary,
                  first: true,
                ),
                avatar(
                  context.l(kWorkers[1].initials),
                  const Color(0xFFFFF1D4),
                  AppColors.text,
                ),
                PositionedDirectional(
                  start: 48,
                  child: avatar(
                    '+35',
                    const Color(0xFFEEF1F4),
                    AppColors.slate,
                    fs: 11,
                    first: true,
                    family: kLatinFont,
                  ),
                ),
              ],
            ),
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
                        context.tr('prosNear'),
                        style: ts(14, w: 600),
                      ),
                    ),
                    const SizedBox(width: 5),
                    const AppIcon(
                      'verified',
                      size: 15,
                      color: AppColors.primary,
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  context.tr('prosNearSub'),
                  style: ts(12.5, c: AppColors.slate),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AvailableDates extends StatelessWidget {
  const _AvailableDates();

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(context.tr('availDates'), style: ts(17, w: 700)),
            Text(
              context.tr('riyadh'),
              style: ts(13, w: 600, c: AppColors.primary),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            for (var i = 0; i < 4; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              Expanded(
                child: Tap(
                  onTap: () => AppRouter.toBooking(
                    context,
                    serviceId: context.appRead.service.id,
                    step: 2,
                    date: i,
                    slot: kDays[i].full ? -1 : (i == 0 ? 4 : 1),
                  ),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: AppColors.line),
                    ),
                    child: Column(
                      children: [
                        Text(
                          context.l(kDays[i].label),
                          style: ts(11.5, c: AppColors.slate),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${kDays[i].number}',
                          style: ts(17, w: 700, family: kLatinFont),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          kDays[i].full
                              ? context.tr('full')
                              : (ar
                                    ? '${i == 0 ? 3 : 6} مواعيد'
                                    : '${i == 0 ? 3 : 6} slots'),
                          style: ts(
                            11,
                            w: 600,
                            c: kDays[i].full
                                ? AppColors.muted
                                : AppColors.primary,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

class _ReviewsSection extends StatelessWidget {
  const _ReviewsSection();

  @override
  Widget build(BuildContext context) {
    final service = context.app.service;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(context.tr('reviewsT'), style: ts(17, w: 700)),
            if (service.rating != null)
              RatingInline(
                rating: service.rating!.toStringAsFixed(1),
                trailing: ' · ${service.reviews ?? 0}',
                size: 13,
                fontSize: 13,
                boldRating: false,
                ratingColor: AppColors.slate,
              ),
          ],
        ),
        const SizedBox(height: 12),
        for (final r in kReviews) ...[
          AppCard(
            padding: const EdgeInsets.all(14),
            radius: 18,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(context.l(r.name), style: ts(14, w: 600)),
                    Row(
                      children: [
                        for (var i = 1; i <= 5; i++)
                          Padding(
                            padding: const EdgeInsetsDirectional.only(start: 2),
                            child: AppIcon(
                              'star',
                              size: 13,
                              color: AppColors.gold,
                              filled: i <= r.stars,
                              strokeWidth: 1.6,
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  context.l(r.text),
                  style: ts(13.5, c: AppColors.slate, h: 1.5),
                ),
                const SizedBox(height: 8),
                Text(context.l(r.date), style: ts(12, c: AppColors.slate)),
              ],
            ),
          ),
          const SizedBox(height: 12),
        ],
      ],
    );
  }
}

class _PolicyCards extends StatelessWidget {
  const _PolicyCards();

  @override
  Widget build(BuildContext context) {
    Widget card(String icon, String title, String body) {
      return Expanded(
        child: AppCard(
          padding: const EdgeInsets.all(14),
          radius: 18,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AppIcon(icon, size: 19, color: AppColors.primary),
              const SizedBox(height: 6),
              Text(title, style: ts(14, w: 600)),
              const SizedBox(height: 6),
              Text(body, style: ts(12.5, c: AppColors.slate, h: 1.45)),
            ],
          ),
        ),
      );
    }

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          card(
            'calendar',
            context.tr('cancelPolicy'),
            context.tr('cancelPolicyTxt'),
          ),
          const SizedBox(width: 10),
          card('lock', context.tr('paymentInfo'), context.tr('paymentInfoTxt')),
        ],
      ),
    );
  }
}
