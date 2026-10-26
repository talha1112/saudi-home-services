import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/service.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

class CategoryCardStyle {
  const CategoryCardStyle({
    required this.bg,
    required this.fg,
    required this.iconBg,
    required this.iconFg,
    required this.ring,
  });
  final Color bg;
  final Color fg;
  final Color iconBg;
  final Color iconFg;
  final Color ring;

  static final teal = CategoryCardStyle(
    bg: AppColors.primary,
    fg: Colors.white,
    iconBg: Colors.white.withValues(alpha: .16),
    iconFg: Colors.white,
    ring: Colors.white.withValues(alpha: .07),
  );
  static const tint = CategoryCardStyle(
    bg: AppColors.tealTint,
    fg: AppColors.text,
    iconBg: Colors.white,
    iconFg: AppColors.primary,
    ring: Color(0x1200695C),
  );
  static final dark = CategoryCardStyle(
    bg: AppColors.text,
    fg: Colors.white,
    iconBg: AppColors.gold.withValues(alpha: .18),
    iconFg: AppColors.gold,
    ring: Colors.white.withValues(alpha: .06),
  );
}

class CategoryCard extends StatelessWidget {
  const CategoryCard({
    super.key,
    required this.category,
    required this.subtitle,
    required this.style,
    required this.onTap,
  });

  final ServiceCategory category;
  final String subtitle;
  final CategoryCardStyle style;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: Container(
          constraints: const BoxConstraints(minHeight: 132),
          color: style.bg,
          padding: const EdgeInsets.fromLTRB(12, 14, 12, 12),
          child: Stack(
            children: [
              PositionedDirectional(
                top: -48,
                end: -46,
                child: Container(
                  width: 96,
                  height: 96,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: style.ring, width: 16),
                  ),
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  IconTile(
                    category.icon,
                    size: 44,
                    radius: 14,
                    iconSize: 22,
                    bg: style.iconBg,
                    fg: style.iconFg,
                  ),
                  const SizedBox(height: 26),
                  Text(
                    context.l(category.name),
                    style: ts(15, w: 700, c: style.fg),
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      Expanded(
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: AlignmentDirectional.centerStart,
                          child: Text(
                            subtitle,
                            maxLines: 1,
                            style: ts(11.5, c: style.fg.withValues(alpha: .8)),
                          ),
                        ),
                      ),
                      AppIcon(
                        context.forwardIcon,
                        size: 15,
                        color: style.fg.withValues(alpha: .8),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
