import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/ribbons.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/models/service.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

/// Step 4: compare the quotes professionals sent back.
class QuotesStep extends StatelessWidget {
  const QuotesStep({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('quotesTitle'), style: ts(21, w: 700)),
        const SizedBox(height: 6),
        Text(
          context.tr('quotesSub'),
          style: ts(14, c: AppColors.slate, h: 1.5),
        ),
        const SizedBox(height: 16),
        for (var i = 0; i < kWorkers.length; i++) ...[
          QuoteCard(
            worker: kWorkers[i],
            index: i,
            selected: app.quoteIndex == i && !app.rejectedQuotes.contains(i),
            rejected: app.rejectedQuotes.contains(i),
            onTap: () {
              if (!app.rejectedQuotes.contains(i)) {
                app.update(() => app.quoteIndex = i);
              }
            },
          ),
          const SizedBox(height: 16),
        ],
      ],
    );
  }
}

class QuoteCard extends StatelessWidget {
  const QuoteCard({
    super.key,
    required this.worker,
    required this.index,
    required this.selected,
    required this.rejected,
    required this.onTap,
  });

  final Worker worker;
  final int index;
  final bool selected;
  final bool rejected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final tag = index == 2
        ? (ar ? 'أفضل سعر' : 'BEST PRICE')
        : (index == 0 ? (ar ? 'الأسرع' : 'FASTEST') : null);
    return Tap(
      onTap: onTap,
      child: Opacity(
        opacity: rejected ? .5 : 1,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(
                  color: selected ? AppColors.primary : AppColors.lineSoft,
                  width: 1.5,
                ),
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      InitialsTile(
                        context.l(worker.initials),
                        size: 48,
                        radius: 16,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    context.l(worker.name),
                                    style: ts(15, w: 600),
                                  ),
                                ),
                                const SizedBox(width: 5),
                                const AppIcon(
                                  'verified',
                                  size: 15,
                                  color: AppColors.primary,
                                ),
                              ],
                            ),
                            const SizedBox(height: 3),
                            RatingInline(
                              rating: worker.rating.toStringAsFixed(1),
                              trailing:
                                  ' · ${ar ? '${worker.jobs} مهمة' : '${worker.jobs} jobs'} · ${ar ? '${worker.distanceKm} كم' : '${worker.distanceKm} km'}',
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      RadioDot(selected: selected),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.only(top: 12),
                    decoration: const BoxDecoration(
                      border: Border(
                        top: BorderSide(color: AppColors.lineSoft),
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const AppIcon('clock', size: 13),
                                  const SizedBox(width: 5),
                                  Flexible(
                                    child: Text(
                                      context.l(worker.availability),
                                      style: ts(12.5, w: 500),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(
                                context.l(worker.note),
                                style: ts(12.5, c: AppColors.slate, h: 1.4),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              context.sar(worker.quote),
                              style: ts(19, w: 700),
                            ),
                            Text(
                              rejected
                                  ? (ar ? 'مرفوض' : 'Rejected')
                                  : (ar ? 'قبل الضريبة' : 'before VAT'),
                              style: ts(11, c: AppColors.slate),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            if (tag != null && !rejected)
              HangingTag(
                tag,
                end: 16,
                bg: index == 2 ? AppColors.gold : AppColors.primary,
                fg: index == 2 ? AppColors.text : Colors.white,
                fontSize: 10,
                radius: 8,
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 5),
              ),
          ],
        ),
      ),
    );
  }
}
