import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/extensions/context_extensions.dart';
import '../../core/utils/text_styles.dart';
import '../widgets/app_icon.dart';
import '../widgets/app_button.dart';
import '../widgets/tap.dart';
import '../widgets/tiles.dart';

const List<BoxShadow> kSoftShadow = [
  BoxShadow(color: Color(0x0A172B35), blurRadius: 16, offset: Offset(0, 4)),
];

/// White rounded container with a hairline border.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.radius = 20,
    this.borderColor = AppColors.lineSoft,
    this.borderWidth = 1,
    this.color = Colors.white,
    this.shadow = false,
    this.onTap,
    this.clip = false,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color borderColor;
  final double borderWidth;
  final Color color;
  final bool shadow;
  final VoidCallback? onTap;
  final bool clip;

  @override
  Widget build(BuildContext context) {
    final box = Container(
      padding: padding,
      clipBehavior: clip ? Clip.antiAlias : Clip.none,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: borderColor, width: borderWidth),
        boxShadow: shadow ? kSoftShadow : null,
      ),
      child: child,
    );
    return onTap == null ? box : Tap(onTap: onTap, child: box);
  }
}

/// Section title with an optional "See all" style action.
class SectionHeader extends StatelessWidget {
  const SectionHeader(
    this.title, {
    super.key,
    this.action,
    this.onAction,
    this.padding,
  });

  final String title;
  final String? action;
  final VoidCallback? onAction;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: padding ?? const EdgeInsets.fromLTRB(20, 26, 20, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(title, style: ts(18, w: 700)),
          if (action != null)
            Tap(
              onTap: onAction,
              child: Text(action!, style: ts(14, w: 600, c: AppColors.primary)),
            ),
        ],
      ),
    );
  }
}

/// Title bar for pushed screens: back button, title, optional trailing widget.
class ScreenHeader extends StatelessWidget {
  const ScreenHeader({
    super.key,
    required this.title,
    this.onBack,
    this.trailing,
    this.bordered = false,
  });

  final String title;
  final VoidCallback? onBack;
  final Widget? trailing;
  final bool bordered;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
      decoration: bordered
          ? const BoxDecoration(
              color: Colors.white,
              border: Border(bottom: BorderSide(color: AppColors.lineSoft)),
            )
          : null,
      child: Row(
        children: [
          SquareIconButton.back(context, onTap: onBack),
          const SizedBox(width: 12),
          Expanded(child: Text(title, style: ts(19, w: 700))),
          ?trailing,
        ],
      ),
    );
  }
}

/// Bottom action area with a top hairline (primary CTA bars).
class BottomBar extends StatelessWidget {
  const BottomBar({super.key, required this.child, this.top = 14});

  final Widget child;
  final double top;

  @override
  Widget build(BuildContext context) {
    final bottom = context.bottomInset;
    return Container(
      padding: EdgeInsets.fromLTRB(
        20,
        top,
        20,
        (bottom > 0 ? bottom : 12) + 12,
      ),
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: AppColors.lineSoft)),
      ),
      child: child,
    );
  }
}

/// Label / value row used in price breakdowns.
class PriceRow extends StatelessWidget {
  const PriceRow(
    this.label,
    this.value, {
    super.key,
    this.labelColor = AppColors.slate,
    this.valueColor = AppColors.text,
    this.fontSize = 14.5,
  });

  final String label;
  final String value;
  final Color labelColor;
  final Color valueColor;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(
          child: Text(label, style: ts(fontSize, c: labelColor)),
        ),
        const SizedBox(width: 12),
        Text(value, style: ts(fontSize, w: 600, c: valueColor)),
      ],
    );
  }
}

class HairlineDivider extends StatelessWidget {
  const HairlineDivider({super.key, this.color = AppColors.lineSoft});
  final Color color;

  @override
  Widget build(BuildContext context) => Container(height: 1, color: color);
}

/// Dashed horizontal rule.
class DashedDivider extends StatelessWidget {
  const DashedDivider({super.key});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final count = (c.maxWidth / 8).floor();
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: List.generate(
            count,
            (_) => Container(width: 4, height: 1.5, color: AppColors.handle),
          ),
        );
      },
    );
  }
}

/// Tinted info box with an icon, used for hints and explanations.
class InfoNote extends StatelessWidget {
  const InfoNote(
    this.text, {
    super.key,
    this.icon = 'info',
    this.bg = AppColors.chip,
    this.fg = AppColors.slate,
    this.iconColor = AppColors.primary,
    this.radius = 14,
  });

  final String text;
  final String icon;
  final Color bg;
  final Color fg;
  final Color iconColor;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: AppIcon(icon, size: 16, color: iconColor),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: ts(13, c: fg, h: 1.5)),
          ),
        ],
      ),
    );
  }
}

/// Centered empty state with an icon tile and optional action.
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.tileBg = AppColors.tealTint,
    this.tileFg = AppColors.primary,
    this.actionLabel,
    this.onAction,
    this.verticalPadding = 48,
  });

  final String icon;
  final String title;
  final String subtitle;
  final Color tileBg;
  final Color tileFg;
  final String? actionLabel;
  final VoidCallback? onAction;
  final double verticalPadding;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: 24, vertical: verticalPadding),
      child: Column(
        children: [
          Container(
            width: 72,
            height: 72,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: tileBg,
              borderRadius: BorderRadius.circular(24),
            ),
            child: AppIcon(icon, size: 30, color: tileFg),
          ),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: ts(17, w: 700)),
          const SizedBox(height: 10),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: ts(14, c: AppColors.slate, h: 1.5),
          ),
          if (actionLabel != null) ...[
            const SizedBox(height: 18),
            AppButton(
              label: actionLabel!,
              onPressed: onAction,
              kind: AppButtonKind.soft,
              height: 44,
              radius: 14,
              fontSize: 15,
              expand: false,
              padding: const EdgeInsets.symmetric(horizontal: 18),
            ),
          ],
        ],
      ),
    );
  }
}
