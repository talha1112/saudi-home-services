import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';

/// Rounded box with a dashed outline.
class DashedBox extends StatelessWidget {
  const DashedBox({
    super.key,
    required this.child,
    this.radius = 16,
    this.color = AppColors.radioRing,
    this.strokeWidth = 1.5,
    this.background,
    this.padding,
    this.width,
    this.height,
    this.alignment,
  });

  final Widget child;
  final double radius;
  final Color color;
  final double strokeWidth;
  final Color? background;
  final EdgeInsetsGeometry? padding;
  final double? width;
  final double? height;
  final AlignmentGeometry? alignment;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _DashedRRect(
        radius: radius,
        color: color,
        strokeWidth: strokeWidth,
        background: background,
      ),
      child: Container(
        width: width,
        height: height,
        padding: padding,
        alignment: alignment,
        child: child,
      ),
    );
  }
}

class _DashedRRect extends CustomPainter {
  _DashedRRect({
    required this.radius,
    required this.color,
    required this.strokeWidth,
    this.background,
  });

  final double radius;
  final Color color;
  final double strokeWidth;
  final Color? background;

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = RRect.fromRectAndRadius(
      Offset.zero & size,
      Radius.circular(radius),
    ).deflate(strokeWidth / 2);
    if (background != null) {
      canvas.drawRRect(rrect, Paint()..color = background!);
    }
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth;
    final path = Path()..addRRect(rrect);
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, d + 5), paint);
        d += 9;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRRect old) =>
      old.radius != radius ||
      old.color != color ||
      old.strokeWidth != strokeWidth ||
      old.background != background;
}

/// Dashed circular ring (onboarding illustration).
class DashedCircle extends StatelessWidget {
  const DashedCircle({super.key, required this.color, this.strokeWidth = 1.5});

  final Color color;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: _DashedCircle(color, strokeWidth),
    size: Size.infinite,
  );
}

class _DashedCircle extends CustomPainter {
  _DashedCircle(this.color, this.strokeWidth);

  final Color color;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth;
    final path = Path()..addOval((Offset.zero & size).deflate(strokeWidth / 2));
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, d + 5), paint);
        d += 9;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedCircle old) => old.color != color;
}
