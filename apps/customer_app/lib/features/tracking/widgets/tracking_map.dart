import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../shared/components/map_mock.dart';
import '../../../shared/widgets/app_icon.dart';

/// Illustrated live-tracking map: roads, blocks, dotted route, the
/// professional's truck (with a pulse) and the destination pin.
class TrackingMap extends StatefulWidget {
  const TrackingMap({super.key});

  @override
  State<TrackingMap> createState() => _TrackingMapState();
}

class _TrackingMapState extends State<TrackingMap>
    with SingleTickerProviderStateMixin {
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
    // Maps always render left-to-right.
    return Directionality(
      textDirection: TextDirection.ltr,
      child: MapCanvas(
        width: 390,
        height: 380,
        children: [
          mapRoad(top: 120, left: -20, right: -20, h: 18, angle: -8),
          mapRoad(left: 96, top: -20, bottom: -20, w: 14),
          mapRoad(left: 270, top: -20, bottom: -20, w: 12, angle: 6),
          mapRoad(top: 262, left: 0, right: 0, h: 12),
          mapBlock(126, 160, 126, 84, color: AppColors.mapPark, radius: 12),
          mapBlock(12, 160, 70, 84, radius: 10),
          mapBlock(126, 20, 130, 80, radius: 10),
          mapBlock(300, 150, 80, 100, radius: 10),
          Positioned.fill(
            child: CustomPaint(
              painter: RoutePainter(const [
                Offset(276, 70),
                Offset(282, 132),
                Offset(103, 154),
                Offset(103, 268),
                Offset(190, 268),
              ]),
            ),
          ),
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
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x6600695C),
                        blurRadius: 16,
                        offset: Offset(0, 6),
                      ),
                    ],
                  ),
                  child: const AppIcon('truck', size: 19, color: Colors.white),
                ),
              ],
            ),
          ),
          const Positioned(
            left: 168,
            top: 234,
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
