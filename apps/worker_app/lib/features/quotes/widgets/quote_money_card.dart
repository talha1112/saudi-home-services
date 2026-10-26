import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/saudi_time.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';

/// The worker's quote as the server priced it. Every amount is the server's; nothing is calculated here.
class QuoteMoneyCard extends StatelessWidget {
  const QuoteMoneyCard({super.key, required this.quote});

  final WorkerQuote quote;

  @override
  Widget build(BuildContext context) {
    final m = quote.money;
    final status = quote.isExpired && quote.status == 'SUBMITTED'
        ? 'EXPIRED'
        : quote.status;
    final key = 'wq$status';
    final statusText = context.tr(key) == key ? status : context.tr(key);
    Widget row(String label, String value, {bool bold = false, Color? color}) =>
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Flexible(
                child: Text(
                  label,
                  style: ts(
                    13.5,
                    c: bold ? AppColors.text : AppColors.slate,
                    w: bold ? 700 : 400,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Text(
                value,
                style: ts(14, w: bold ? 700 : 600, c: color ?? AppColors.text),
              ),
            ],
          ),
        );
    return AppCard(
      key: const Key('quote-card'),
      padding: const EdgeInsets.all(14),
      radius: 18,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(context.tr('wjYourQuote'), style: ts(15, w: 700)),
              Text(
                statusText,
                key: const Key('quote-status'),
                style: ts(13, w: 600, c: AppColors.primary),
              ),
            ],
          ),
          const SizedBox(height: 8),
          row(context.tr('wjYourPrice'), context.sar(m.service)),
          row(context.tr('wjVat'), context.sar(m.vatHalalas / 100)),
          row(context.tr('wjCustomerPays'), context.sar(m.total)),
          row(context.tr('wjCommission'), context.sarNeg(m.commission)),
          const Divider(height: 18),
          row(
            context.tr('wjYouReceive'),
            context.sar(m.payout),
            bold: true,
            color: AppColors.primary,
          ),
          if (quote.validUntil != null && quote.status == 'SUBMITTED')
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '${context.tr('wjValidFor')}: ${whenLabel(quote.validUntil, arabic: context.isAr)}',
                style: ts(12.5, c: AppColors.slate),
              ),
            ),
        ],
      ),
    );
  }
}
