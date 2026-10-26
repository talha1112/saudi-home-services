import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';

class _Look {
  const _Look(this.icon, this.bg, this.fg);
  final String icon;
  final Color bg;
  final Color fg;
}

const _looks = {
  QuoteState.pending: _Look('clock', AppColors.cream, Color(0xFFB07A10)),
  QuoteState.accepted: _Look('check', AppColors.tealTint, AppColors.primary),
  QuoteState.rejected: _Look('x', AppColors.dangerBg, AppColors.danger),
  QuoteState.withdrawn: _Look('x', Color(0xFFEEF2F4), AppColors.slate),
  QuoteState.none: _Look('file', Color(0xFFEEF2F4), AppColors.slate),
};

class QuoteStatusScreen extends StatelessWidget {
  const QuoteStatusScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final r = app.request;
    final state = app.quoteState;
    final look = _looks[state]!;
    final cust = context.l(r.customer);
    final (title, desc) = switch (state) {
      QuoteState.pending => (
        ar ? 'بانتظار رد $cust' : 'Waiting for $cust',
        ar
            ? 'أرسلت عرضك. تقارن العميلة 3 عروض. ينتهي عرضك خلال 1:58 ساعة.'
            : 'Your quote is sent. The customer is comparing 3 quotes. Yours expires in 1 h 58 min.',
      ),
      QuoteState.accepted => (
        ar ? 'تم قبول عرضك' : 'Quote accepted',
        ar
            ? 'دفعت $cust وتم تأكيد المهمة اليوم 6:00 م.'
            : '$cust paid and the job is confirmed for today at 6:00 PM.',
      ),
      QuoteState.rejected => (
        ar ? 'لم يتم اختيار عرضك' : 'Quote not selected',
        ar
            ? 'اختارت العميلة عرضاً آخر. لا توجد رسوم عليك.'
            : 'The customer chose another quote. Nothing is charged to you.',
      ),
      QuoteState.withdrawn => (
        ar ? 'تم سحب العرض' : 'Quote withdrawn',
        ar ? 'لن تراه العميلة بعد الآن.' : 'The customer no longer sees it.',
      ),
      QuoteState.none => (ar ? 'لم يُرسل عرض بعد' : 'No quote sent yet', ''),
    };

    Widget line(
      String k,
      String v, {
      Color kc = AppColors.slate,
      Color vc = AppColors.text,
      int w = 600,
    }) => Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(
          child: Text(k, style: ts(14, c: kc)),
        ),
        const SizedBox(width: 12),
        Text(
          v,
          style: ts(14, w: w, c: vc),
        ),
      ],
    );

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
              child: Row(
                children: [
                  SquareIconButton.back(
                    context,
                    onTap: () => AppRouter.toJobsTab(context, tab: 1),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      context.tr('quoteStatus'),
                      style: ts(18, w: 700),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 24,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(24),
                      border: Border.all(color: AppColors.lineSoft),
                    ),
                    child: Column(
                      children: [
                        IconTile(
                          look.icon,
                          size: 76,
                          radius: 26,
                          iconSize: 34,
                          bg: look.bg,
                          fg: look.fg,
                        ),
                        const SizedBox(height: 10),
                        Text(
                          title,
                          textAlign: TextAlign.center,
                          style: ts(22, w: 700),
                        ),
                        if (desc.isNotEmpty) ...[
                          const SizedBox(height: 10),
                          Text(
                            desc,
                            textAlign: TextAlign.center,
                            style: ts(14, c: AppColors.slate, h: 1.5),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Container(
                          padding: const EdgeInsets.only(bottom: 10),
                          decoration: const BoxDecoration(
                            border: Border(
                              bottom: BorderSide(color: AppColors.lineFaint),
                            ),
                          ),
                          child: Row(
                            children: [
                              AppIcon(
                                r.icon,
                                size: 18,
                                color: AppColors.primary,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  context.l(r.service),
                                  style: ts(16, w: 600),
                                ),
                              ),
                              Text(cust, style: ts(12.5, c: AppColors.slate)),
                            ],
                          ),
                        ),
                        const SizedBox(height: 10),
                        line(context.tr('minCharge'), context.sar(kMinCharge)),
                        const SizedBox(height: 10),
                        line(
                          ar ? 'أجور العمل' : 'Labour',
                          context.sar(app.labourAmount),
                        ),
                        const SizedBox(height: 10),
                        line(
                          ar ? 'القطع' : 'Parts',
                          context.sar(app.partsAmount),
                        ),
                        const SizedBox(height: 10),
                        line(
                          ar ? 'الإجمالي قبل الضريبة' : 'Total before VAT',
                          context.sar(app.gross),
                          kc: AppColors.text,
                          w: 700,
                        ),
                        const SizedBox(height: 10),
                        line(
                          context.tr('youEarn'),
                          context.sar(app.net),
                          kc: AppColors.primary,
                          vc: AppColors.primary,
                          w: 700,
                        ),
                      ],
                    ),
                  ),
                  if (state == QuoteState.pending) ...[
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: AppButton(
                            label: context.tr('editQuote'),
                            kind: AppButtonKind.soft,
                            height: 48,
                            radius: 15,
                            fontSize: 14,
                            onPressed: () => AppRouter.toQuote(context),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: AppButton(
                            label: context.tr('withdraw'),
                            kind: AppButtonKind.outline,
                            height: 48,
                            radius: 15,
                            fontSize: 14,
                            onPressed: () => app.update(
                              () => app.quoteState = QuoteState.withdrawn,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Text(
                      ar
                          ? context.tr('demoCustomer')
                          : context.tr('demoCustomer').toUpperCase(),
                      style: ts(11, w: 700, c: AppColors.muted, ls: 0.66),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: AppButton(
                            label: context.tr('custAccepts'),
                            kind: AppButtonKind.outline,
                            dashed: true,
                            height: 40,
                            radius: 12,
                            fontSize: 13,
                            onPressed: () => app.update(() {
                              app.quoteState = QuoteState.accepted;
                              app.stage = 0;
                            }),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: AppButton(
                            label: context.tr('custRejects'),
                            kind: AppButtonKind.outline,
                            height: 40,
                            radius: 12,
                            fontSize: 13,
                            onPressed: () => app.update(
                              () => app.quoteState = QuoteState.rejected,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            if (state == QuoteState.accepted)
              BottomBar(
                child: AppButton(
                  label: context.tr('startJob'),
                  onPressed: () => AppRouter.toActive(context),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
