import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/extensions/context_extensions.dart';
import '../../core/utils/text_styles.dart';
import '../models/mock_data.dart';
import 'cards.dart';

/// Itemised price lines and total for the currently selected quote.
class PriceBreakdown extends StatelessWidget {
  const PriceBreakdown({super.key, this.fontSize = 14.5, this.spacing = 12});

  final double fontSize;
  final double spacing;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final lines = <Widget>[
      PriceRow(
        context.tr('minCharge'),
        context.sar(kMinCharge),
        fontSize: fontSize,
      ),
      PriceRow(
        ar ? 'أعمال إضافية حسب العرض' : 'Additional work (quote)',
        context.sar(app.gross - kMinCharge),
        fontSize: fontSize,
      ),
      if (app.discount > 0)
        PriceRow(
          ar ? 'عرض AC20 (20%)' : 'Offer AC20 (20%)',
          context.sarNeg(app.discount),
          labelColor: AppColors.primary,
          valueColor: AppColors.primary,
          fontSize: fontSize,
        ),
      PriceRow(
        ar ? 'المجموع الفرعي' : 'Subtotal',
        context.sar(app.subtotal),
        fontSize: fontSize,
      ),
      PriceRow(
        ar ? 'ضريبة القيمة المضافة 15%' : 'VAT 15%',
        context.sar(app.vat),
        fontSize: fontSize,
      ),
    ];
    return Column(
      children: [
        for (var i = 0; i < lines.length; i++) ...[
          if (i > 0) SizedBox(height: spacing),
          lines[i],
        ],
        const SizedBox(height: 12),
        const HairlineDivider(),
        const SizedBox(height: 12),
        TotalRow(label: context.tr('qTotal'), value: context.sar(app.total)),
      ],
    );
  }
}

class TotalRow extends StatelessWidget {
  const TotalRow({super.key, required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: ts(16, w: 700)),
        Text(value, style: ts(24, w: 800)),
      ],
    );
  }
}
