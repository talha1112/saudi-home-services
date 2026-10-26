import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';

/// Dark card: what the customer pays, commission and what the worker earns.
class EarningsSummary extends StatelessWidget {
  const EarningsSummary({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final soft = Colors.white.withValues(alpha: .8);
    Widget line(String k, String v) => Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(
          child: Text(k, style: ts(14, c: soft)),
        ),
        const SizedBox(width: 12),
        Text(v, style: ts(14, w: 600, c: Colors.white)),
      ],
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.text,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          line(context.tr('custPays'), context.sar(app.gross)),
          const SizedBox(height: 10),
          line(
            ar
                ? 'عمولة المنصة (${app.plan.rate}% · ${context.l(app.plan.name)})'
                : 'Platform commission (${app.plan.rate}% · ${context.l(app.plan.name)})',
            context.sarNeg(app.commission),
          ),
          const SizedBox(height: 10),
          Container(height: 1, color: Colors.white.withValues(alpha: .15)),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                context.tr('youEarn'),
                style: ts(15, w: 600, c: Colors.white),
              ),
              Text(
                context.sar(app.net),
                style: ts(24, w: 800, c: AppColors.gold),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            context.tr('vatNote'),
            style: ts(11.5, c: Colors.white.withValues(alpha: .7), h: 1.45),
          ),
        ],
      ),
    );
  }
}
