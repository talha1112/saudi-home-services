import 'package:flutter/material.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

const _reasons = [
  Bi('Booked by mistake', 'حجزت بالخطأ'),
  Bi('No longer needed', 'لم أعد بحاجة للخدمة'),
  Bi('Professional is late', 'تأخر الفني'),
  Bi('Found another provider', 'وجدت مزوداً آخر'),
];

Future<void> showCancelSheet(BuildContext context) =>
    showAppSheet<void>(context, builder: (_) => const _CancelSheet());

Future<void> showCallSheet(BuildContext context) =>
    showAppSheet<void>(context, builder: (_) => const _CallSheet());

class _CancelSheet extends StatefulWidget {
  const _CancelSheet();

  @override
  State<_CancelSheet> createState() => _CancelSheetState();
}

class _CancelSheetState extends State<_CancelSheet> {
  int _reason = 0;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final fee = app.cancellationFee;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('cancelTitle'), style: ts(21, w: 700)),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: AppColors.background,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: [
              AppIcon(app.service.icon, size: 17, color: AppColors.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  context.l(app.service.name),
                  style: ts(13.5, w: 600),
                ),
              ),
              Text(app.whenLabel(ar), style: ts(13.5, c: AppColors.slate)),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Text(context.tr('reason'), style: ts(13, w: 600, c: AppColors.slate)),
        const SizedBox(height: 14),
        for (var i = 0; i < _reasons.length; i++) ...[
          Tap(
            onTap: () => setState(() => _reason = i),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(13),
                border: Border.all(
                  color: _reason == i ? AppColors.primary : AppColors.lineSoft,
                  width: 1.5,
                ),
              ),
              child: Row(
                children: [
                  RadioDot(selected: _reason == i, size: 20),
                  const SizedBox(width: 10),
                  Expanded(child: Text(context.l(_reasons[i]), style: ts(14))),
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
        ],
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.cream,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(context.tr('cancelFee'), style: ts(14)),
                  Text(
                    fee > 0 ? context.sar(fee) : (ar ? 'مجاناً' : 'Free'),
                    style: ts(14, w: 700),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(context.tr('refund'), style: ts(14)),
                  Text(
                    context.sar(app.total - fee),
                    style: ts(14, w: 700, c: AppColors.primary),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                '${fee > 0 ? (ar ? 'يُطبق الحد الأدنى لأن الفني في الطريق.' : 'The minimum charge applies because your professional is already on the way.') : (ar ? 'لم يتحرك الفني بعد، لذا الإلغاء مجاني.' : 'Your professional hasn’t set off yet, so cancelling is free.')} ${context.tr('refundNote')}',
                style: ts(12.5, c: AppColors.creamDeep, h: 1.45),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: AppButton(
                label: context.tr('keepBooking'),
                kind: AppButtonKind.soft,
                height: 52,
                radius: 16,
                fontSize: 15,
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: AppButton(
                label: context.tr('confirmCancel'),
                kind: AppButtonKind.dark,
                height: 52,
                radius: 16,
                fontSize: 15,
                onPressed: () {
                  app.update(() => app.cancelled = true);
                  Navigator.of(context).pop();
                  AppRouter.toBookingsTab(context, tab: 3);
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _CallSheet extends StatefulWidget {
  const _CallSheet();

  @override
  State<_CallSheet> createState() => _CallSheetState();
}

class _CallSheetState extends State<_CallSheet> {
  bool _calling = false;

  @override
  Widget build(BuildContext context) {
    final worker = context.app.worker;
    final ar = context.isAr;
    final name = context.l(worker.name);
    final title = _calling
        ? (ar ? 'جارٍ الاتصال بـ$name…' : 'Calling $name…')
        : (ar ? 'الاتصال بـ$name؟' : 'Call $name?');
    final sub = _calling
        ? (ar
              ? 'يتم الاتصال عبر خط آمن. رقمك يبقى خاصاً.'
              : 'Connecting through a secure line. Your number stays private.')
        : (ar
              ? 'تتم المكالمة عبر خط خدمات المنزل الآمن، ولا يظهر رقمك للفني.'
              : 'Calls go through a secure Home Services line. Your number isn’t shared.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        const SizedBox(height: 8),
        InitialsTile(
          context.l(worker.initials),
          size: 72,
          fontSize: 24,
          radius: 24,
        ),
        const SizedBox(height: 12),
        Text(title, textAlign: TextAlign.center, style: ts(21, w: 700)),
        const SizedBox(height: 12),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Text(
            sub,
            textAlign: TextAlign.center,
            style: ts(14, c: AppColors.slate, h: 1.5),
          ),
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: AppButton(
                label: _calling ? context.tr('close') : context.tr('cancel'),
                kind: AppButtonKind.outline,
                height: 52,
                radius: 16,
                fontSize: 15,
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: AppButton(
                label: _calling ? context.tr('endCall') : context.tr('callNow'),
                icon: 'phone',
                height: 52,
                radius: 16,
                fontSize: 15,
                background: _calling ? AppColors.danger : AppColors.primary,
                onPressed: () {
                  if (_calling) {
                    Navigator.of(context).pop();
                  } else {
                    setState(() => _calling = true);
                  }
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}
