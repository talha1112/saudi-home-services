import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/components/confirm_sheet.dart';

/// "Call customer?" confirmation sheet.
Future<void> showCallSheet(BuildContext context) {
  final ar = context.isAr;
  final name = context.l(context.appRead.request.customer);
  return showAppSheet<void>(
    context,
    builder: (ctx) => ConfirmSheetBody(
      icon: 'phone',
      title: ar ? 'الاتصال بـ$name؟' : 'Call $name?',
      description: ar
          ? 'تتم المكالمة عبر خط آمن، ولا يظهر رقمك للعميل.'
          : 'Calls go through a secure line. Your number isn’t shared with the customer.',
      cancelLabel: ar ? 'إلغاء' : 'Cancel',
      confirmLabel: ar ? 'اتصل الآن' : 'Call now',
      tileBg: AppColors.tealTint,
      tileFg: AppColors.primary,
      confirmColor: AppColors.primary,
      onConfirm: () {},
    ),
  );
}
