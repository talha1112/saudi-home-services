import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../shared/components/map_mock.dart';
import '../../../shared/widgets/app_icon.dart';

/// Illustrated navigation map: solid route, pulsing van and the job pin.
class JobMap extends StatefulWidget {
  const JobMap({super.key});

  @override
  State<JobMap> createState() => _JobMapState();
}

class _JobMapState extends State<JobMap> with SingleTickerProviderStateMixin {
  late final AnimationController _ping = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  )..repeat();

  @override
  void dispose() {
    _ping.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: MapCanvas(
        width: 390,
        height: 330,
        children: [
          mapRoad(top: 120, left: -20, right: -20, h: 18, angle: -8),
          mapRoad(left: 96, top: -20, bottom: -20, w: 14),
          mapRoad(left: 270, top: -20, bottom: -20, w: 12, angle: 6),
          mapRoad(top: 250, left: 0, right: 0, h: 12),
          mapBlock(126, 160, 126, 76, color: AppColors.mapPark, radius: 12),
          mapBlock(126, 20, 130, 80, radius: 10),
          const Positioned.fill(child: CustomPaint(painter: _SolidRoute())),
          Positioned(
            left: 254,
            top: 48,
            width: 44,
            height: 44,
            child: Stack(
              children: [
                AnimatedBuilder(
                  animation: _ping,
                  builder: (context, _) => Opacity(
                    opacity: .45 * (1 - _ping.value),
                    child: Transform.scale(
                      scale: 1 + 1.6 * _ping.value,
                      child: Container(
                        decoration: const BoxDecoration(
                          color: AppColors.primary,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
                ),
                Container(
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.primary,
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white, width: 3),
                  ),
                  child: const AppIcon('truck', size: 19, color: Colors.white),
                ),
              ],
            ),
          ),
          const Positioned(
            left: 168,
            top: 222,
            child: MapPin(
              icon: 'home',
              size: 40,
              color: AppColors.text,
              iconSize: 18,
            ),
          ),
        ],
      ),
    );
  }
}

class _SolidRoute extends CustomPainter {
  const _SolidRoute();

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..moveTo(276, 70)
      ..lineTo(282, 132)
      ..lineTo(103, 154)
      ..lineTo(103, 256)
      ..lineTo(190, 256);
    canvas.drawPath(
      path,
      Paint()
        ..color = AppColors.primary
        ..style = PaintingStyle.stroke
        ..strokeWidth = 6
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(_SolidRoute old) => false;
}
