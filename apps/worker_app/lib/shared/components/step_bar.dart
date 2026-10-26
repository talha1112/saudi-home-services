import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';

/// Segmented progress bar: the first [step] of [total] segments are filled.
class StepBar extends StatelessWidget {
  const StepBar({
    super.key,
    required this.step,
    required this.total,
    this.gap = 5,
  });

  final int step;
  final int total;
  final double gap;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 1; i <= total; i++) ...[
          if (i > 1) SizedBox(width: gap),
          Expanded(
            child: Container(
              height: 5,
              decoration: BoxDecoration(
                color: i <= step ? AppColors.primary : AppColors.line,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ],
      ],
    );
  }
}
