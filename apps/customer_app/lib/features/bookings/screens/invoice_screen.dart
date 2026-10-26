import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/invoice_code.dart';

/// Simplified tax invoice for a completed booking (static sample data).
class InvoiceScreen extends StatelessWidget {
  const InvoiceScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final leak = serviceById('leak');
    final meta = [
      (ar ? 'رقم الفاتورة' : 'Invoice no.', 'INV-2026-08812'),
      (ar ? 'رقم الحجز' : 'Booking ID', 'HS-238114'),
      (ar ? 'التاريخ' : 'Date', ar ? '21 سبتمبر 2026' : '21 Sep 2026'),
      (ar ? 'الخدمة' : 'Service', context.l(leak.name)),
      (ar ? 'الفني' : 'Professional', context.l(kWorkers[1].name)),
      (ar ? 'طريقة الدفع' : 'Paid with', 'mada •••• 4821'),
    ];
    final lines = [
      (context.tr('minCharge'), context.sar(99)),
      (ar ? 'مبلغ الخدمة' : 'Service amount', context.sar(61)),
      (ar ? 'الخصم' : 'Discount', context.sar(0)),
      (ar ? 'المجموع الفرعي' : 'Subtotal', context.sar(160)),
      (ar ? 'ضريبة القيمة المضافة 15%' : 'VAT 15%', context.sar(24)),
    ];
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            ScreenHeader(
              title: context.tr('invoice'),
              onBack: () => AppRouter.toBookingsTab(context, tab: 2),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                children: [
                  Container(
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(color: AppColors.lineSoft),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x0D172B35),
                          blurRadius: 24,
                          offset: Offset(0, 6),
                        ),
                      ],
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Row(
                              children: [
                                const IconTile(
                                  'wrench',
                                  size: 40,
                                  radius: 13,
                                  iconSize: 19,
                                  bg: AppColors.primary,
                                  fg: Colors.white,
                                ),
                                const SizedBox(width: 10),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      context.tr('brand'),
                                      style: ts(15, w: 700),
                                    ),
                                    const SizedBox(height: 1),
                                    Text(
                                      context.tr('taxInvoice'),
                                      style: ts(12, c: AppColors.slate),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                            Pill(
                              context.tr('paid'),
                              icon: 'check',
                              fontSize: 12.5,
                              weight: 700,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 5,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AppColors.background,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: Wrap(
                            runSpacing: 14,
                            children: [
                              for (final m in meta)
                                FractionallySizedBox(
                                  widthFactor: .5,
                                  child: Padding(
                                    padding: const EdgeInsetsDirectional.only(
                                      end: 12,
                                    ),
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          m.$1,
                                          style: ts(11.5, c: AppColors.slate),
                                        ),
                                        const SizedBox(height: 3),
                                        Text(m.$2, style: ts(13.5, w: 600)),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                        for (final l in lines) ...[
                          PriceRow(l.$1, l.$2, fontSize: 14),
                          const SizedBox(height: 11),
                        ],
                        const SizedBox(height: 5),
                        const DashedDivider(),
                        const SizedBox(height: 16),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.baseline,
                          textBaseline: TextBaseline.alphabetic,
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(context.tr('total'), style: ts(16, w: 700)),
                            Text(context.sar(184), style: ts(24, w: 800)),
                          ],
                        ),
                        const SizedBox(height: 20),
                        Row(
                          children: [
                            const InvoiceCode(),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Text.rich(
                                TextSpan(
                                  style: ts(12, c: AppColors.slate, h: 1.5),
                                  children: [
                                    TextSpan(text: '${context.tr('vatNo')} '),
                                    TextSpan(
                                      text: '310 245 678 900 003\n',
                                      style: ts(
                                        12,
                                        c: AppColors.slate,
                                        family: kLatinFont,
                                        h: 1.5,
                                      ),
                                    ),
                                    TextSpan(text: context.tr('zatca')),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            BottomBar(
              child: AppButton(
                label: context.tr('download'),
                icon: 'download',
                height: 54,
                radius: 17,
                fontSize: 15.5,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
