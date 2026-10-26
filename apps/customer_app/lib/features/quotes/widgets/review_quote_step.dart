import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/components/price_breakdown.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';

/// Step 5: review the selected quote and its price breakdown.
class ReviewQuoteStep extends StatefulWidget {
  const ReviewQuoteStep({
    super.key,
    required this.changeOpen,
    required this.changeSent,
    required this.onSendChange,
  });

  final bool changeOpen;
  final bool changeSent;
  final VoidCallback onSendChange;

  @override
  State<ReviewQuoteStep> createState() => _ReviewQuoteStepState();
}

class _ReviewQuoteStepState extends State<ReviewQuoteStep> {
  final _change = TextEditingController();

  @override
  void dispose() {
    _change.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final worker = app.worker;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          padding: const EdgeInsets.all(14),
          radius: 18,
          child: Row(
            children: [
              InitialsTile(context.l(worker.initials), size: 48, radius: 16),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      context.tr('quoteFrom'),
                      style: ts(12.5, c: AppColors.slate),
                    ),
                    const SizedBox(height: 3),
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
                  ],
                ),
              ),
              const Pill(
                '14:52',
                icon: 'clock',
                bg: AppColors.cream,
                fg: AppColors.creamText,
                radius: 10,
                padding: EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                family: kLatinFont,
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                context.l(worker.note),
                style: ts(13, c: AppColors.slate, h: 1.5),
              ),
              const SizedBox(height: 12),
              const PriceBreakdown(),
            ],
          ),
        ),
        const SizedBox(height: 16),
        InfoNote(
          context.tr('minIncluded'),
          bg: AppColors.tealTint,
          fg: AppColors.tealDeep,
          iconColor: AppColors.tealDeep,
        ),
        if (widget.changeOpen) ...[
          const SizedBox(height: 16),
          TextAreaBox(
            controller: _change,
            hint: context.tr('changePh'),
            height: 90,
            fontSize: 14.5,
            radius: 16,
          ),
          const SizedBox(height: 16),
          AppButton(
            label: context.tr('sendReq'),
            kind: AppButtonKind.dark,
            height: 48,
            radius: 15,
            onPressed: widget.onSendChange,
          ),
        ],
        if (widget.changeSent) ...[
          const SizedBox(height: 16),
          InfoNote(
            context.tr('reqSent'),
            icon: 'clock',
            bg: AppColors.cream,
            fg: AppColors.creamDeep,
            iconColor: AppColors.creamDeep,
          ),
        ],
      ],
    );
  }
}
