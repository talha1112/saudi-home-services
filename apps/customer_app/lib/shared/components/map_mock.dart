import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/theme/app_colors.dart';
import '../widgets/app_icon.dart';

/// Pin marker (teardrop rotated -45deg) with an icon inside.
class MapPin extends StatelessWidget {
  const MapPin({
    super.key,
    required this.icon,
    this.size = 44,
    this.color = AppColors.primary,
    this.iconSize = 20,
  });

  final String icon;
  final double size;
  final Color color;
  final double iconSize;

  @override
  Widget build(BuildContext context) {
    return Transform.rotate(
      angle: -math.pi / 4,
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(size / 2),
            topRight: Radius.circular(size / 2),
            bottomRight: Radius.circular(size / 2),
            bottomLeft: const Radius.circular(4),
          ),
          boxShadow: [
            BoxShadow(
              color: color.withValues(alpha: .35),
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Transform.rotate(
          angle: math.pi / 4,
          child: AppIcon(icon, size: iconSize, color: Colors.white),
        ),
      ),
    );
  }
}

/// Fixed-layout canvas scaled to cover its parent, used by the mock maps so
/// the road/block composition is identical at every width.
class MapCanvas extends StatelessWidget {
  const MapCanvas({
    super.key,
    required this.width,
    required this.height,
    required this.children,
  });

  final double width;
  final double height;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox(
          width: width,
          height: height,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Positioned.fill(child: Container(color: AppColors.mapBase)),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

Widget mapBlock(
  double left,
  double top,
  double w,
  double h, {
  Color color = AppColors.mapBlock,
  double radius = 8,
}) {
  return Positioned(
    left: left,
    top: top,
    child: Container(
      width: w,
      height: h,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
      ),
    ),
  );
}

Widget mapRoad({
  double? left,
  double? top,
  double? right,
  double? bottom,
  double? w,
  double? h,
  double angle = 0,
}) {
  return Positioned(
    left: left,
    top: top,
    right: right,
    bottom: bottom,
    child: Transform.rotate(
      angle: angle * math.pi / 180,
      child: Container(width: w, height: h, color: Colors.white),
    ),
  );
}

/// Dotted route polyline.
class RoutePainter extends CustomPainter {
  RoutePainter(this.points);
  final List<Offset> points;

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()..moveTo(points.first.dx, points.first.dy);
    for (final p in points.skip(1)) {
      path.lineTo(p.dx, p.dy);
    }
    final dot = Paint()..color = AppColors.primary;
    for (final m in path.computeMetrics()) {
      for (var d = 0.0; d < m.length; d += 11) {
        canvas.drawCircle(m.getTangentForOffset(d)!.position, 2.5, dot);
      }
    }
  }

  @override
  bool shouldRepaint(RoutePainter old) => false;
}
