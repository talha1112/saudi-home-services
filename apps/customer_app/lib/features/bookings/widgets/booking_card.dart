import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';

enum BookingBadge {
  active(AppColors.tealTint, AppColors.primary),
  neutral(Color(0xFFEEF2F4), Color(0xFF334155)),
  warning(AppColors.cream, AppColors.creamText);

  const BookingBadge(this.bg, this.fg);
  final Color bg;
  final Color fg;
}

/// View model for a row in the bookings list.
class BookingEntry {
  const BookingEntry({
    required this.icon,
    required this.name,
    required this.date,
    required this.worker,
    required this.workerInitials,
    required this.status,
    required this.badge,
    required this.amount,
    required this.primaryLabel,
    required this.onPrimary,
    this.primaryFilled = false,
    this.rating,
    this.secondaryLabel,
    this.onSecondary,
  });

  final String icon;
  final String name;
  final String date;
  final String worker;
  final String workerInitials;
  final String status;
  final BookingBadge badge;
  final String amount;
  final String primaryLabel;
  final VoidCallback onPrimary;
  final bool primaryFilled;
  final String? rating;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;
}

class BookingCard extends StatelessWidget {
  const BookingCard({super.key, required this.entry});

  final BookingEntry entry;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(entry.icon, size: 46, radius: 15, iconSize: 21),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(entry.name, style: ts(15, w: 600)),
                    const SizedBox(height: 3),
                    Text(entry.date, style: ts(12.5, c: AppColors.slate)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Pill(entry.status, bg: entry.badge.bg, fg: entry.badge.fg),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.only(top: 12),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: AppColors.lineFaint)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Flexible(
                  child: Row(
                    children: [
                      InitialsTile(
                        entry.workerInitials,
                        size: 26,
                        fontSize: 11,
                        radius: 9,
                        bg: AppColors.chip,
                        fg: AppColors.text,
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          entry.worker,
                          style: ts(13, c: AppColors.slate),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (entry.rating != null) ...[
                        const SizedBox(width: 8),
                        const AppIcon(
                          'star',
                          size: 12,
                          color: AppColors.gold,
                          filled: true,
                          strokeWidth: 0,
                        ),
                        const SizedBox(width: 3),
                        Text(entry.rating!, style: ts(13, w: 600)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Text(entry.amount, style: ts(15, w: 700)),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppButton(
                  label: entry.primaryLabel,
                  kind: entry.primaryFilled
                      ? AppButtonKind.primary
                      : AppButtonKind.soft,
                  height: 42,
                  radius: 13,
                  fontSize: 13.5,
                  onPressed: entry.onPrimary,
                ),
              ),
              if (entry.secondaryLabel != null) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: AppButton(
                    label: entry.secondaryLabel!,
                    kind: AppButtonKind.outline,
                    icon: 'file',
                    height: 42,
                    radius: 13,
                    fontSize: 13.5,
                    onPressed: entry.onSecondary,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
