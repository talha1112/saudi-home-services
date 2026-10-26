import 'package:flutter/material.dart';

import '../../../app/localization/app_strings.dart';
import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../models/payment_method.dart';

class ConfirmScreen extends StatelessWidget {
  const ConfirmScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final method = kPaymentMethods.firstWhere(
      (m) => m.id == app.payMethod,
      orElse: () => kPaymentMethods.first,
    );
    final rows = [
      (ar ? 'رقم الحجز' : 'Booking no.', 'HS-240871'),
      (ar ? 'الخدمة' : 'Service', context.l(app.service.name)),
      (ar ? 'الموعد' : 'Date & time', app.whenLabel(ar)),
      (ar ? 'الفني' : 'Professional', context.l(app.worker.name)),
      (ar ? 'المبلغ المدفوع' : 'Amount paid', context.sar(app.total)),
      (
        ar ? 'طريقة الدفع' : 'Paid with',
        method.name is String
            ? method.name as String
            : context.l(method.name as Bi),
      ),
    ];
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
          child: Column(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.only(top: 20),
                  child: Column(
                    children: [
                      Container(
                        width: 96,
                        height: 96,
                        alignment: Alignment.center,
                        decoration: const BoxDecoration(
                          color: AppColors.tealTint,
                          shape: BoxShape.circle,
                        ),
                        child: Container(
                          width: 68,
                          height: 68,
                          alignment: Alignment.center,
                          decoration: const BoxDecoration(
                            color: AppColors.primary,
                            shape: BoxShape.circle,
                          ),
                          child: const AppIcon(
                            'check',
                            size: 34,
                            color: Colors.white,
                            strokeWidth: 3,
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      Text(context.tr('confirmed'), style: ts(26, w: 700)),
                      const SizedBox(height: 14),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 300),
                        child: Text(
                          context.tr('confirmedSub'),
                          textAlign: TextAlign.center,
                          style: ts(15, c: AppColors.slate, h: 1.5),
                        ),
                      ),
                      const SizedBox(height: 24),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(color: AppColors.lineSoft),
                        ),
                        child: Column(
                          children: [
                            for (var i = 0; i < rows.length; i++)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 12,
                                ),
                                decoration: BoxDecoration(
                                  border: Border(
                                    bottom: BorderSide(
                                      color: AppColors.lineFaint,
                                    ),
                                  ),
                                ),
                                child: Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    Text(
                                      rows[i].$1,
                                      style: ts(14, c: AppColors.slate),
                                    ),
                                    const SizedBox(width: 12),
                                    Flexible(
                                      child: Text(
                                        rows[i].$2,
                                        textAlign: TextAlign.end,
                                        style: ts(14, w: 600),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 14),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const AppIcon(
                            'receipt',
                            size: 15,
                            color: AppColors.primary,
                          ),
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              context.tr('receiptSent'),
                              style: ts(12.5, c: AppColors.slate),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              AppButton(
                label: context.tr('track'),
                icon: 'locate',
                onPressed: () => AppRouter.toTrack(context),
              ),
              const SizedBox(height: 10),
              AppButton(
                label: context.tr('viewBooking'),
                kind: AppButtonKind.soft,
                height: 52,
                radius: 16,
                fontSize: 15,
                onPressed: () => AppRouter.toBookingsTab(context, tab: 1),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
