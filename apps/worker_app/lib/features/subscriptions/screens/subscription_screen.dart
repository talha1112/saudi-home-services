import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/confirm_sheet.dart';
import '../../../shared/components/ribbons.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';

class SubscriptionScreen extends StatelessWidget {
  const SubscriptionScreen({super.key});

  void _confirmCancel(BuildContext context) {
    final ar = context.isAr;
    final app = context.appRead;
    showAppSheet<void>(
      context,
      builder: (_) => ConfirmSheetBody(
        icon: 'alert',
        title: ar ? 'إلغاء الاشتراك الاحترافي؟' : 'Cancel your Pro plan?',
        description: ar
            ? 'تبقى مزاياك حتى 1 نوفمبر، ثم تنتقل للباقة الأساسية بعمولة 18%.'
            : 'You keep Pro benefits until 1 Nov, then move to Basic with 18% commission.',
        cancelLabel: ar ? 'الإبقاء' : 'Keep Pro',
        confirmLabel: ar ? 'إلغاء الاشتراك' : 'Cancel plan',
        tileBg: AppColors.dangerBg,
        tileFg: AppColors.danger,
        confirmColor: AppColors.danger,
        onConfirm: () => app.update(() => app.planId = 'basic'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final cur = app.plan;
    String price(SubscriptionPlan p) =>
        p.price > 0 ? context.sar(p.price) : (ar ? 'مجاناً' : 'Free');
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: EdgeInsets.fromLTRB(20, 6, 20, context.bottomInset + 20),
          children: [
            Row(
              children: [
                SquareIconButton.back(
                  context,
                  onTap: () => AppRouter.toProfileTab(context),
                ),
                const SizedBox(width: 12),
                Text(context.tr('subscription'), style: ts(19, w: 700)),
              ],
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: AppColors.text,
                borderRadius: BorderRadius.circular(24),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        context.tr('currentPlan'),
                        style: ts(12.5, c: Colors.white.withValues(alpha: .75)),
                      ),
                      Pill(
                        ar
                            ? context.l(cur.name)
                            : context.l(cur.name).toUpperCase(),
                        bg: AppColors.gold,
                        fg: AppColors.text,
                        fontSize: 12,
                        weight: 800,
                        radius: 8,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        letterSpacing: 0.96,
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Text(price(cur), style: ts(32, w: 800, c: Colors.white)),
                      const SizedBox(width: 6),
                      Text(
                        context.tr('perMonth'),
                        style: ts(14, c: Colors.white.withValues(alpha: .7)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  for (final p in cur.perks) ...[
                    Row(
                      children: [
                        const AppIcon(
                          'check',
                          size: 15,
                          color: AppColors.gold,
                          strokeWidth: 2.6,
                        ),
                        const SizedBox(width: 8),
                        Text(context.l(p), style: ts(13.5, c: Colors.white)),
                      ],
                    ),
                    const SizedBox(height: 8),
                  ],
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: .08),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        const AppIcon(
                          'calendar',
                          size: 15,
                          color: Colors.white,
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            app.planId == 'basic'
                                ? (ar
                                      ? 'تنتقل للباقة الأساسية في 1 نوفمبر'
                                      : 'Moves to Basic on 1 Nov')
                                : (ar
                                      ? 'يتجدد تلقائياً في 1 نوفمبر 2026'
                                      : 'Renews automatically on 1 Nov 2026'),
                            style: ts(13, c: Colors.white),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Text(context.tr('plans'), style: ts(16, w: 700)),
            const SizedBox(height: 16),
            for (final p in kPlans) ...[
              _PlanCard(
                plan: p,
                current: p.id == app.planId,
                upgrade: p.price > cur.price,
                priceText: price(p),
                onPick: () => app.update(() => app.planId = p.id),
              ),
              const SizedBox(height: 16),
            ],
            Text(context.tr('payHistory'), style: ts(16, w: 700)),
            const SizedBox(height: 16),
            Container(
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: AppColors.lineSoft),
              ),
              child: Column(
                children: [
                  for (final h in [
                    (
                      ar ? 'احترافية · أكتوبر' : 'Pro · October',
                      ar ? '1 أكتوبر' : '1 Oct',
                    ),
                    (
                      ar ? 'احترافية · سبتمبر' : 'Pro · September',
                      ar ? '1 سبتمبر' : '1 Sep',
                    ),
                    (
                      ar ? 'احترافية · أغسطس' : 'Pro · August',
                      ar ? '1 أغسطس' : '1 Aug',
                    ),
                  ])
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 13,
                      ),
                      decoration: const BoxDecoration(
                        border: Border(
                          bottom: BorderSide(color: AppColors.lineFaint),
                        ),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(h.$1, style: ts(14, w: 600)),
                                const SizedBox(height: 2),
                                Text(
                                  '${h.$2} · mada •••• 0932',
                                  style: ts(12, c: AppColors.slate),
                                ),
                              ],
                            ),
                          ),
                          Text(context.sar(149), style: ts(14, w: 700)),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            AppButton(
              label: context.tr('cancelSub'),
              kind: AppButtonKind.outline,
              height: 50,
              radius: 16,
              fontSize: 15,
              onPressed: () => _confirmCancel(context),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({
    required this.plan,
    required this.current,
    required this.upgrade,
    required this.priceText,
    required this.onPick,
  });

  final SubscriptionPlan plan;
  final bool current;
  final bool upgrade;
  final String priceText;
  final VoidCallback onPick;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final label = current
        ? (ar ? 'باقتك الحالية' : 'Current plan')
        : (upgrade ? (ar ? 'ترقية' : 'Upgrade') : (ar ? 'تغيير' : 'Switch'));
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: current ? AppColors.primary : AppColors.lineSoft,
              width: 1.5,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(context.l(plan.name), style: ts(17, w: 700)),
                  Text.rich(
                    TextSpan(
                      style: ts(17, w: 700),
                      children: [
                        TextSpan(text: priceText),
                        if (plan.price > 0)
                          TextSpan(
                            text: ' ${ar ? 'شهرياً' : '/ mo'}',
                            style: ts(12, w: 500, c: AppColors.slate),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              for (final k in plan.perks) ...[
                Row(
                  children: [
                    const AppIcon(
                      'check',
                      size: 14,
                      color: AppColors.primary,
                      strokeWidth: 2.6,
                    ),
                    const SizedBox(width: 8),
                    Text(context.l(k), style: ts(13, c: AppColors.slate)),
                  ],
                ),
                const SizedBox(height: 6),
              ],
              const SizedBox(height: 4),
              AppButton(
                label: label,
                kind: AppButtonKind.soft,
                background: current
                    ? const Color(0xFFEEF2F4)
                    : (upgrade ? AppColors.primary : AppColors.tealTint),
                height: 42,
                radius: 13,
                fontSize: 14,
                enabled: !current,
                onPressed: onPick,
              ),
            ],
          ),
        ),
        if (plan.id == 'elite')
          HangingTag(
            ar ? 'أفضل قيمة' : 'BEST VALUE',
            end: 16,
            fontSize: 10,
            radius: 8,
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 5),
          ),
      ],
    );
  }
}
