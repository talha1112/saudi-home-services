import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tiles.dart';

enum JobBadge {
  fresh(AppColors.cream, AppColors.creamText),
  active(AppColors.tealTint, AppColors.primary),
  done(Color(0xFFEEF2F4), Color(0xFF334155)),
  bad(AppColors.dangerBg, AppColors.danger);

  const JobBadge(this.bg, this.fg);
  final Color bg;
  final Color fg;
}

/// View model for one row of the jobs list.
class JobEntry {
  const JobEntry({
    required this.icon,
    required this.service,
    required this.subtitle,
    required this.when,
    required this.status,
    required this.badge,
    required this.amountLabel,
    required this.amount,
    this.note,
    this.buttonLabel,
    this.onButton,
    this.softButton = false,
  });

  final String icon;
  final String service;
  final String subtitle;
  final String when;
  final String status;
  final JobBadge badge;
  final String amountLabel;
  final String amount;
  final String? note;
  final String? buttonLabel;
  final VoidCallback? onButton;
  final bool softButton;
}

class JobCard extends StatelessWidget {
  const JobCard({super.key, required this.job, required this.dateTimeLabel});

  final JobEntry job;
  final String dateTimeLabel;

  @override
  Widget build(BuildContext context) {
    Widget cell(String k, String v, {int w = 600}) => Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(k, style: ts(12.5, c: AppColors.slate)),
          const SizedBox(height: 2),
          Text(v, style: ts(12.5, w: w)),
        ],
      ),
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(job.icon, size: 46, radius: 15, iconSize: 21),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(job.service, style: ts(15, w: 600)),
                    const SizedBox(height: 3),
                    Text(job.subtitle, style: ts(12.5, c: AppColors.slate)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Pill(
                job.status,
                bg: job.badge.bg,
                fg: job.badge.fg,
                fontSize: 11.5,
                weight: 700,
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.background,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                cell(dateTimeLabel, job.when),
                const SizedBox(width: 8),
                cell(job.amountLabel, job.amount, w: 700),
              ],
            ),
          ),
          if (job.note != null) ...[
            const SizedBox(height: 12),
            Text(job.note!, style: ts(12.5, c: AppColors.slate, h: 1.45)),
          ],
          if (job.buttonLabel != null) ...[
            const SizedBox(height: 12),
            AppButton(
              label: job.buttonLabel!,
              kind: job.softButton ? AppButtonKind.soft : AppButtonKind.primary,
              height: 44,
              radius: 14,
              fontSize: 14,
              onPressed: job.onButton,
            ),
          ],
        ],
      ),
    );
  }
}
