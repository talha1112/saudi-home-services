import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/tap.dart';

/// One tab of the jobs screen: label, optional count, selected state.
class JobsTabChip extends StatelessWidget {
  const JobsTabChip({
    super.key,
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        height: 38,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: selected ? AppColors.primary : Colors.white,
          borderRadius: BorderRadius.circular(19),
          border: Border.all(
            color: selected ? AppColors.primary : AppColors.line,
          ),
        ),
        child: Row(
          children: [
            Text(
              label,
              style: ts(
                13.5,
                w: 600,
                c: selected ? Colors.white : AppColors.text,
              ),
            ),
            if (count > 0) ...[
              const SizedBox(width: 6),
              Container(
                constraints: const BoxConstraints(minWidth: 18),
                height: 18,
                padding: const EdgeInsets.symmetric(horizontal: 5),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: selected
                      ? Colors.white.withValues(alpha: .25)
                      : AppColors.tealTint,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Text(
                  '$count',
                  style: ts(
                    11,
                    c: selected ? Colors.white : AppColors.primary,
                    family: kLatinFont,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
