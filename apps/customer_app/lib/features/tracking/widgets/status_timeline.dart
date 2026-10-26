import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_icon.dart';

/// Segmented progress bar, one bar per stage.
class StageBars extends StatelessWidget {
  const StageBars({super.key, required this.stage});
  final int stage;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < kStages.length; i++) ...[
          if (i > 0) const SizedBox(width: 4),
          Expanded(
            child: Container(
              height: 5,
              decoration: BoxDecoration(
                color: i <= stage ? AppColors.primary : AppColors.line,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// Vertical timeline of booking stages with timestamps.
class StatusTimeline extends StatelessWidget {
  const StatusTimeline({super.key, required this.stage});
  final int stage;

  @override
  Widget build(BuildContext context) {
    final isDone = stage == 6;
    return Column(
      children: [
        for (var i = 0; i < kStages.length; i++)
          _Row(
            label: context.l(kStages[i].label),
            time: i <= stage ? context.l(kStages[i].time) : '',
            done: i < stage || (isDone && i == 6),
            current: i == stage && !isDone,
            reached: i <= stage,
            lineActive: i < stage,
            last: i == kStages.length - 1,
          ),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.label,
    required this.time,
    required this.done,
    required this.current,
    required this.reached,
    required this.lineActive,
    required this.last,
  });

  final String label;
  final String time;
  final bool done;
  final bool current;
  final bool reached;
  final bool lineActive;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 22,
            child: Column(
              children: [
                Container(
                  width: 22,
                  height: 22,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: done ? AppColors.primary : Colors.white,
                    border: Border.all(
                      color: (done || current)
                          ? AppColors.primary
                          : const Color(0xFFD5DDE2),
                      width: 2,
                    ),
                  ),
                  child: done
                      ? const AppIcon(
                          'check',
                          size: 12,
                          color: Colors.white,
                          strokeWidth: 3.2,
                        )
                      : null,
                ),
                Expanded(
                  child: Container(
                    width: 2,
                    color: last
                        ? Colors.transparent
                        : (lineActive ? AppColors.primary : AppColors.line),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 28),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Flexible(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          label,
                          style: ts(
                            14,
                            w: current ? 700 : 500,
                            c: reached ? AppColors.text : AppColors.muted,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text(time, style: ts(12.5, c: AppColors.slate)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
