import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

/// Settings-style row: icon tile, label, optional value and a forward arrow.
class ProfileRow extends StatelessWidget {
  const ProfileRow({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    required this.last,
    required this.onTap,
  });

  final String icon;
  final String label;
  final String value;
  final bool last;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          border: last
              ? null
              : const Border(bottom: BorderSide(color: AppColors.lineFaint)),
        ),
        child: Row(
          children: [
            IconTile(
              icon,
              size: 38,
              radius: 12,
              iconSize: 18,
              bg: AppColors.chip,
              fg: AppColors.text,
            ),
            const SizedBox(width: 12),
            Expanded(child: Text(label, style: ts(15, w: 500))),
            if (value.isNotEmpty) ...[
              Text(value, style: ts(13, c: AppColors.slate)),
              const SizedBox(width: 12),
            ],
            AppIcon(context.forwardIcon, size: 18, color: AppColors.muted),
          ],
        ),
      ),
    );
  }
}

/// Full-width action row (log out, delete account).
class ProfileAction extends StatelessWidget {
  const ProfileAction({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.color = AppColors.text,
    this.bordered = false,
  });

  final String icon;
  final String label;
  final VoidCallback onTap;
  final Color color;
  final bool bordered;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: Colors.white,
          border: bordered
              ? const Border(bottom: BorderSide(color: AppColors.lineFaint))
              : null,
        ),
        child: Row(
          children: [
            AppIcon(icon, size: 19, color: color),
            const SizedBox(width: 12),
            Text(label, style: ts(15, w: 600, c: color)),
          ],
        ),
      ),
    );
  }
}
