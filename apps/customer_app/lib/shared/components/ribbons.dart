import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../../core/extensions/context_extensions.dart';
import '../../core/utils/text_styles.dart';

/// Diagonal corner ribbon on the end edge of a card. Place inside a Stack
/// whose parent clips (e.g. `ClipRRect`). Mirrors automatically in RTL.
class CornerRibbon extends StatelessWidget {
  const CornerRibbon(
    this.text, {
    super.key,
    this.top = 20,
    this.end = -36,
    this.width = 140,
    this.vertical = 5,
    this.fontSize = 11,
    this.bg = AppColors.gold,
    this.fg = AppColors.text,
    this.shadow = false,
  });

  final String text;
  final double top;
  final double end;
  final double width;
  final double vertical;
  final double fontSize;
  final Color bg;
  final Color fg;
  final bool shadow;

  @override
  Widget build(BuildContext context) {
    return PositionedDirectional(
      top: top,
      end: end,
      width: width,
      child: Transform.rotate(
        angle: context.isAr ? -math.pi / 4 : math.pi / 4,
        child: Container(
          alignment: Alignment.center,
          padding: EdgeInsets.symmetric(vertical: vertical),
          decoration: BoxDecoration(
            color: bg,
            boxShadow: shadow
                ? const [
                    BoxShadow(
                      color: Color(0x1F172B35),
                      blurRadius: 10,
                      offset: Offset(0, 4),
                    ),
                  ]
                : null,
          ),
          child: Text(
            text,
            style: ts(fontSize, w: 800, c: fg, ls: fontSize * 0.06),
          ),
        ),
      ),
    );
  }
}

/// Tag that hangs from the top edge of a card.
class HangingTag extends StatelessWidget {
  const HangingTag(
    this.text, {
    super.key,
    this.start,
    this.end,
    this.top = -1,
    this.bg = AppColors.gold,
    this.fg = AppColors.text,
    this.fontSize = 10.5,
    this.radius = 9,
    this.padding = const EdgeInsets.fromLTRB(9, 5, 9, 6),
  });

  final String text;
  final double? start;
  final double? end;
  final double top;
  final Color bg;
  final Color fg;
  final double fontSize;
  final double radius;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return PositionedDirectional(
      top: top,
      start: start,
      end: end,
      child: Container(
        padding: padding,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.vertical(bottom: Radius.circular(radius)),
        ),
        child: Text(
          text,
          style: ts(fontSize, w: 800, c: fg, ls: fontSize * 0.06),
        ),
      ),
    );
  }
}
