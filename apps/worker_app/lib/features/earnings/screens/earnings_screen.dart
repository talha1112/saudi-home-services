import 'package:flutter/material.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/demo_data.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/real_earnings.dart';

const _periods = [
  (Bi('Today', 'اليوم'), 300),
  (Bi('This week', 'هذا الأسبوع'), 2140),
  (Bi('This month', 'هذا الشهر'), 8960),
];

const _periodTabs = [
  Bi('Today', 'اليوم'),
  Bi('Week', 'الأسبوع'),
  Bi('Month', 'الشهر'),
];

// (height value, English day, Arabic day)
const _bars = [
  (180, 'S', 'س'),
  (420, 'S', 'أ'),
  (300, 'M', 'ن'),
  (0, 'T', 'ث'),
  (520, 'W', 'ر'),
  (420, 'T', 'خ'),
  (300, 'F', 'ج'),
];

class EarningsScreen extends StatelessWidget {
  const EarningsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    // A real build adds up the worker's own jobs; the figures below are prototype content (demo builds only).
    if (!kDemoData) return const RealEarnings();
    final app = context.app;
    final ar = context.isAr;
    final period = _periods[app.earningsPeriod];
    final gross = period.$2;
    final comm = (gross * app.plan.rate).round() / 100;
    final net = ((gross - comm) * 100).round() / 100;
    final soft = Colors.white.withValues(alpha: .8);

    Widget statBox(String k, String v) => Expanded(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: .1),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(k, style: ts(12, c: soft)),
            const SizedBox(height: 3),
            Text(v, style: ts(16, w: 700, c: Colors.white)),
          ],
        ),
      ),
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(context.tr('earnings'), style: ts(26, w: 700)),
        ),
        const SizedBox(height: 16),
        SegmentedTabs(
          labels: [for (final p in _periodTabs) context.l(p)],
          selected: app.earningsPeriod,
          onChanged: (i) => app.update(() => app.earningsPeriod = i),
          radius: 11,
          outerRadius: 14,
          fontSize: 13.5,
        ),
        const SizedBox(height: 16),
        ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: Container(
            color: AppColors.primary,
            child: Stack(
              children: [
                PositionedDirectional(
                  top: -80,
                  end: -60,
                  child: Container(
                    width: 200,
                    height: 200,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: Colors.white.withValues(alpha: .06),
                        width: 30,
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        '${context.tr('netEarnings')} · ${context.l(period.$1)}',
                        style: ts(13, c: Colors.white.withValues(alpha: .85)),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        context.sar(net),
                        style: ts(36, w: 800, c: Colors.white, ls: -0.36),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          statBox(context.tr('gross'), context.sar(gross)),
                          const SizedBox(width: 10),
                          statBox(
                            context.tr('platformComm'),
                            context.sarNeg(comm),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Directionality(
                        textDirection: TextDirection.ltr,
                        child: SizedBox(
                          height: 84,
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              for (var i = 0; i < _bars.length; i++) ...[
                                if (i > 0) const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      Container(
                                        height: (_bars[i].$1 / 520 * 64)
                                            .clamp(4, 64)
                                            .toDouble(),
                                        decoration: BoxDecoration(
                                          color: i == 4
                                              ? AppColors.gold
                                              : Colors.white.withValues(
                                                  alpha: .35,
                                                ),
                                          borderRadius: BorderRadius.circular(
                                            6,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(height: 5),
                                      Text(
                                        ar ? _bars[i].$3 : _bars[i].$2,
                                        style: ts(10.5, c: soft),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: AppCard(
                  padding: const EdgeInsets.all(14),
                  radius: 18,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('available'),
                        style: ts(12, c: AppColors.slate),
                      ),
                      const SizedBox(height: 6),
                      Text(context.sar(1334), style: ts(20, w: 700)),
                      const SizedBox(height: 10),
                      AppButton(
                        label: context.tr('withdraw2'),
                        height: 36,
                        radius: 11,
                        fontSize: 13,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: AppCard(
                  padding: const EdgeInsets.all(14),
                  radius: 18,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('pending'),
                        style: ts(12, c: AppColors.slate),
                      ),
                      const SizedBox(height: 6),
                      Text(context.sar(485), style: ts(20, w: 700)),
                      const SizedBox(height: 6),
                      Text(
                        context.tr('pendingSub'),
                        style: ts(11.5, c: AppColors.slate, h: 1.4),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(context.tr('howCalc'), style: ts(16, w: 700)),
              const SizedBox(height: 12),
              Directionality(
                textDirection: TextDirection.ltr,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: SizedBox(
                    height: 12,
                    child: Row(
                      children: [
                        Expanded(
                          flex: 85,
                          child: Container(color: AppColors.primary),
                        ),
                        Expanded(
                          flex: 15,
                          child: Container(color: AppColors.gold),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              PriceRow(context.tr('bookingAmt'), context.sar(300)),
              const SizedBox(height: 12),
              _Legend(
                color: AppColors.gold,
                label: context.tr('platformFee15'),
                value: context.sarNeg(45),
              ),
              const SizedBox(height: 12),
              const HairlineDivider(),
              const SizedBox(height: 12),
              _Legend(
                color: AppColors.primary,
                label: context.tr('workerEarn'),
                value: context.sar(255),
                bold: true,
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 20, bottom: 16),
          child: Text(context.tr('payouts'), style: ts(16, w: 700)),
        ),
        Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AppColors.lineSoft),
          ),
          child: Column(
            children: [
              _Payout(
                label: ar ? 'تحويل أسبوعي' : 'Weekly payout',
                date: ar
                    ? '5 أكتوبر · الراجحي •••• 0932'
                    : '5 Oct · Al Rajhi •••• 0932',
                amount: context.sar(1240.5),
                status: ar ? 'مُرسل' : 'Sent',
              ),
              _Payout(
                label: ar ? 'تحويل أسبوعي' : 'Weekly payout',
                date: ar
                    ? '28 سبتمبر · الراجحي •••• 0932'
                    : '28 Sep · Al Rajhi •••• 0932',
                amount: context.sar(1612),
                status: ar ? 'مُرسل' : 'Sent',
              ),
              _Payout(
                label: ar ? 'سحب فوري' : 'Instant withdrawal',
                date: ar ? '24 سبتمبر · رسوم 5 ر.س' : '24 Sep · fee SAR 5',
                amount: context.sar(500),
                status: ar ? 'مُرسل' : 'Sent',
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 20, bottom: 16),
          child: Text(context.tr('statements'), style: ts(16, w: 700)),
        ),
        for (final s in [
          ar ? 'كشف سبتمبر 2026' : 'September 2026 statement',
          ar ? 'كشف أغسطس 2026' : 'August 2026 statement',
        ]) ...[
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            radius: 16,
            child: Row(
              children: [
                const AppIcon('file', size: 19, color: AppColors.primary),
                const SizedBox(width: 12),
                Expanded(child: Text(s, style: ts(14, w: 500))),
                const AppIcon('download', size: 18, color: AppColors.slate),
              ],
            ),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({
    required this.color,
    required this.label,
    required this.value,
    this.bold = false,
  });

  final Color color;
  final String label;
  final String value;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(
          child: Row(
            children: [
              Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  label,
                  style: ts(
                    bold ? 15 : 14,
                    w: bold ? 700 : 400,
                    c: bold ? AppColors.text : AppColors.slate,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Text(
          value,
          style: ts(
            bold ? 15 : 14,
            w: bold ? 800 : 600,
            c: bold ? AppColors.primary : AppColors.text,
          ),
        ),
      ],
    );
  }
}

class _Payout extends StatelessWidget {
  const _Payout({
    required this.label,
    required this.date,
    required this.amount,
    required this.status,
  });

  final String label;
  final String date;
  final String amount;
  final String status;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: AppColors.lineFaint)),
      ),
      child: Row(
        children: [
          const IconTile(
            'card',
            size: 38,
            radius: 12,
            iconSize: 18,
            bg: AppColors.chip,
            fg: AppColors.text,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: ts(14, w: 600)),
                const SizedBox(height: 2),
                Text(date, style: ts(12, c: AppColors.slate)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(amount, style: ts(14.5, w: 700)),
              const SizedBox(height: 3),
              Text(status, style: ts(11, w: 700, c: AppColors.primary)),
            ],
          ),
        ],
      ),
    );
  }
}
