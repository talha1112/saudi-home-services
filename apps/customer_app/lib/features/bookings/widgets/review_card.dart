import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../logic/booking_detail_controller.dart';

/// "Rate your professional" for a completed booking: the stars and comment to send, or the review already written.
class ReviewCard extends StatefulWidget {
  const ReviewCard({super.key, required this.controller});

  final BookingDetailController controller;

  @override
  State<ReviewCard> createState() => _ReviewCardState();
}

class _ReviewCardState extends State<ReviewCard> {
  int _stars = 0;
  final _comment = TextEditingController();

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Widget _row(int filled, {ValueChanged<int>? onPick, double size = 30}) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      for (var i = 1; i <= 5; i++)
        Tap(
          key: Key('star-$i'),
          onTap: onPick == null ? null : () => onPick(i),
          child: Padding(
            padding: const EdgeInsetsDirectional.only(end: 6),
            child: AppIcon(
              'star',
              size: size,
              color: AppColors.gold,
              filled: i <= filled,
              strokeWidth: 1.6,
            ),
          ),
        ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    // Until the server has said whether a review exists, show nothing rather than a form that may be refused.
    if (!c.reviewChecked) return const SizedBox.shrink();
    final mine = c.review;
    return Container(
      key: const Key('review-card'),
      margin: const EdgeInsets.only(top: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.lineSoft),
      ),
      child: mine != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(context.tr('rvDone'), style: ts(15, w: 700)),
                const SizedBox(height: 10),
                _row(mine.rating, size: 22),
                if ((mine.comment ?? '').isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    mine.comment!,
                    key: const Key('review-comment'),
                    style: ts(13.5, c: AppColors.slate, h: 1.5),
                  ),
                ],
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(context.tr('rvTitle'), style: ts(15, w: 700)),
                const SizedBox(height: 4),
                Text(
                  context.tr('rvSub'),
                  style: ts(13, c: AppColors.slate, h: 1.45),
                ),
                const SizedBox(height: 12),
                _row(_stars, onPick: (n) => setState(() => _stars = n)),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('review-comment-field'),
                  controller: _comment,
                  maxLines: 3,
                  maxLength: 1000,
                  decoration: InputDecoration(
                    hintText: context.tr('rvHint'),
                    counterText: '',
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                ),
                if (c.reviewFailed) ...[
                  const SizedBox(height: 8),
                  Text(
                    context.tr('rvFailed'),
                    key: const Key('review-failed'),
                    style: ts(13, c: AppColors.danger),
                  ),
                ],
                const SizedBox(height: 12),
                AppButton(
                  key: const Key('review-submit'),
                  label: c.reviewing
                      ? context.tr('profSaving')
                      : context.tr('rvSubmit'),
                  enabled: _stars > 0 && !c.reviewing,
                  onPressed: () => c.submitReview(_stars, _comment.text),
                ),
              ],
            ),
    );
  }
}
