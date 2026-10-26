import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';

/// Five segment progress bar for the booking flow.
class BookingProgress extends StatelessWidget {
  const BookingProgress({super.key, required this.step, this.total = 5});

  final int step;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 1; i <= total; i++) ...[
          if (i > 1) const SizedBox(width: 5),
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
