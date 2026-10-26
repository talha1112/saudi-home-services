import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/utils/text_styles.dart';
import 'app_icon.dart';
import 'tap.dart';

enum AppButtonKind { primary, soft, outline, dark, gold, onTeal }

/// Full-width rounded button used across the app. When [enabled] is false it
/// is drawn in the muted "disabled" teal and ignores taps.
class AppButton extends StatelessWidget {
  const AppButton({
    super.key,
    required this.label,
    this.onPressed,
    this.kind = AppButtonKind.primary,
    this.height = 56,
    this.radius = 18,
    this.fontSize = 16,
    this.icon,
    this.trailingIcon,
    this.leading,
    this.enabled = true,
    this.expand = true,
    this.padding = const EdgeInsets.symmetric(horizontal: 18),
    this.background,
    this.weight = 600,
    this.dashed = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final AppButtonKind kind;
  final double height;
  final double radius;
  final double fontSize;
  final String? icon;
  final String? trailingIcon;
  final Widget? leading;
  final bool enabled;
  final bool expand;
  final EdgeInsetsGeometry padding;
  final Color? background;
  final int weight;
  final bool dashed;

  @override
  Widget build(BuildContext context) {
    var bg = switch (kind) {
      AppButtonKind.primary => AppColors.primary,
      AppButtonKind.soft => AppColors.tealTint,
      AppButtonKind.outline => Colors.white,
      AppButtonKind.dark => AppColors.text,
      AppButtonKind.gold => AppColors.gold,
      AppButtonKind.onTeal => Colors.white,
    };
    final fg = switch (kind) {
      AppButtonKind.primary || AppButtonKind.dark => Colors.white,
      AppButtonKind.soft || AppButtonKind.onTeal => AppColors.primary,
      AppButtonKind.outline || AppButtonKind.gold => AppColors.text,
    };
    if (background != null) bg = background!;
    if (!enabled && kind == AppButtonKind.primary) bg = AppColors.disabled;

    final border = kind == AppButtonKind.outline
        ? Border.all(
            color: dashed ? AppColors.tealBorder : AppColors.line,
            width: 1.5,
          )
        : null;

    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (leading != null) ...[leading!, const SizedBox(width: 10)],
        if (icon != null) ...[
          AppIcon(icon!, size: fontSize + 2, color: fg),
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ts(fontSize, w: weight, c: fg),
          ),
        ),
        if (trailingIcon != null) ...[
          const SizedBox(width: 8),
          AppIcon(trailingIcon!, size: 20, color: fg),
        ],
      ],
    );

    return Tap(
      onTap: enabled ? onPressed : null,
      child: Container(
        height: height,
        padding: padding,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(radius),
          border: border,
        ),
        child: content,
      ),
    );
  }
}
