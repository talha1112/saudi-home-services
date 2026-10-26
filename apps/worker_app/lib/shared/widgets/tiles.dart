import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/extensions/context_extensions.dart';
import '../../core/utils/text_styles.dart';
import 'app_icon.dart';
import 'tap.dart';

/// Rounded square holding an icon (service tiles, list leading icons).
class IconTile extends StatelessWidget {
  const IconTile(
    this.icon, {
    super.key,
    this.size = 44,
    this.iconSize,
    this.radius,
    this.bg = AppColors.tealTint,
    this.fg = AppColors.primary,
    this.strokeWidth = 2,
  });

  final String icon;
  final double size;
  final double? iconSize;
  final double? radius;
  final Color bg;
  final Color fg;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(radius ?? size * 0.32),
      ),
      child: AppIcon(
        icon,
        size: iconSize ?? size * 0.46,
        color: fg,
        strokeWidth: strokeWidth,
      ),
    );
  }
}

/// Rounded square with initials (professionals, user).
class InitialsTile extends StatelessWidget {
  const InitialsTile(
    this.text, {
    super.key,
    this.size = 48,
    this.fontSize = 16,
    this.bg = AppColors.tealTint,
    this.fg = AppColors.primary,
    this.circle = false,
    this.radius,
    this.borderColor,
  });

  final String text;
  final double size;
  final double fontSize;
  final Color bg;
  final Color fg;
  final bool circle;
  final double? radius;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: bg,
        shape: circle ? BoxShape.circle : BoxShape.rectangle,
        borderRadius: circle
            ? null
            : BorderRadius.circular(radius ?? size * 0.32),
        border: borderColor == null
            ? null
            : Border.all(color: borderColor!, width: 2),
      ),
      child: Text(text, style: ts(fontSize, w: 700, c: fg)),
    );
  }
}

/// White rounded square button with an icon (back, bell, close...).
class SquareIconButton extends StatelessWidget {
  const SquareIconButton({
    super.key,
    required this.icon,
    this.onTap,
    this.size = 44,
    this.radius = 14,
    this.iconSize = 22,
    this.bg = Colors.white,
    this.fg = AppColors.text,
    this.bordered = true,
    this.shadow = false,
  });

  /// Back button that follows the reading direction.
  factory SquareIconButton.back(
    BuildContext context, {
    VoidCallback? onTap,
    bool bordered = true,
    bool shadow = false,
  }) {
    return SquareIconButton(
      icon: context.backIcon,
      onTap: onTap ?? () => Navigator.of(context).maybePop(),
      bordered: bordered,
      shadow: shadow,
    );
  }

  final String icon;
  final VoidCallback? onTap;
  final double size;
  final double radius;
  final double iconSize;
  final Color bg;
  final Color fg;
  final bool bordered;
  final bool shadow;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(radius),
          border: bordered ? Border.all(color: AppColors.line) : null,
          boxShadow: shadow
              ? const [
                  BoxShadow(
                    color: Color(0x1F172B35),
                    blurRadius: 12,
                    offset: Offset(0, 4),
                  ),
                ]
              : null,
        ),
        child: AppIcon(icon, size: iconSize, color: fg),
      ),
    );
  }
}

/// Selectable radio indicator (teal ring + dot).
class RadioDot extends StatelessWidget {
  const RadioDot({super.key, required this.selected, this.size = 22});

  final bool selected;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppColors.primary : AppColors.radioRing;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: color, width: 2),
      ),
      child: Container(
        width: size * 0.45,
        height: size * 0.45,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: selected ? AppColors.primary : Colors.transparent,
        ),
      ),
    );
  }
}

/// Small rounded label (status badges, discount chips).
class Pill extends StatelessWidget {
  const Pill(
    this.text, {
    super.key,
    this.bg = AppColors.tealTint,
    this.fg = AppColors.primary,
    this.fontSize = 12,
    this.weight = 600,
    this.radius = 9,
    this.padding = const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    this.icon,
    this.family,
    this.letterSpacing,
  });

  final String text;
  final Color bg;
  final Color fg;
  final double fontSize;
  final int weight;
  final double radius;
  final EdgeInsetsGeometry padding;
  final String? icon;
  final String? family;
  final double? letterSpacing;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            AppIcon(icon!, size: fontSize + 1, color: fg),
            const SizedBox(width: 5),
          ],
          Text(
            text,
            style: ts(
              fontSize,
              w: weight,
              c: fg,
              family: family,
              ls: letterSpacing,
            ),
          ),
        ],
      ),
    );
  }
}

/// Gold star followed by a rating and optional trailing text.
class RatingInline extends StatelessWidget {
  const RatingInline({
    super.key,
    required this.rating,
    this.trailing,
    this.size = 12,
    this.fontSize = 12.5,
    this.color = AppColors.slate,
    this.ratingColor = AppColors.text,
    this.boldRating = true,
  });

  final String rating;
  final String? trailing;
  final double size;
  final double fontSize;
  final Color color;
  final Color ratingColor;
  final bool boldRating;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AppIcon(
          'star',
          size: size,
          color: AppColors.gold,
          filled: true,
          strokeWidth: 0,
        ),
        const SizedBox(width: 4),
        Text(
          rating,
          style: ts(fontSize, w: boldRating ? 600 : 400, c: ratingColor),
        ),
        if (trailing != null) Text(trailing!, style: ts(fontSize, c: color)),
      ],
    );
  }
}

/// Selectable pill chip (category / filter / tag).
class SelectChip extends StatelessWidget {
  const SelectChip({
    super.key,
    required this.label,
    required this.selected,
    this.onTap,
    this.height = 40,
    this.radius = 20,
    this.fontSize = 14,
    this.weight = 600,
    this.icon,
    this.selectedBg = AppColors.primary,
    this.selectedFg = Colors.white,
    this.selectedBorder,
    this.unselectedFg = AppColors.text,
    this.horizontal = 16,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final double height;
  final double radius;
  final double fontSize;
  final int weight;
  final String? icon;
  final Color selectedBg;
  final Color selectedFg;
  final Color? selectedBorder;
  final Color unselectedFg;
  final double horizontal;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? selectedFg : unselectedFg;
    return Tap(
      onTap: onTap,
      child: Container(
        height: height,
        padding: EdgeInsets.symmetric(horizontal: horizontal),
        decoration: BoxDecoration(
          color: selected ? selectedBg : Colors.white,
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(
            color: selected ? (selectedBorder ?? selectedBg) : AppColors.line,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              AppIcon(icon!, size: 14, color: fg),
              const SizedBox(width: 6),
            ],
            Text(
              label,
              style: ts(fontSize, w: weight, c: fg),
            ),
          ],
        ),
      ),
    );
  }
}
