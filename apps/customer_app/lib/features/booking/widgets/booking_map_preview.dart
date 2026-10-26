import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/map_mock.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';

/// Static illustrated map with a home pin and a "use current location" chip.
/// Maps are not localised, so the layout is always left-to-right.
class BookingMapPreview extends StatelessWidget {
  const BookingMapPreview({super.key, this.onOpenMap});

  /// Opens the real map picker.
  final VoidCallback? onOpenMap;

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(20),
        child: SizedBox(
          height: 150,
          child: Stack(
            children: [
              Positioned.fill(
                child: MapCanvas(
                  width: 350,
                  height: 150,
                  children: [
                    mapRoad(top: 58, left: 0, right: 0, h: 14),
                    mapRoad(left: 120, top: 0, bottom: 0, w: 12),
                    mapRoad(left: 258, top: 0, bottom: 0, w: 9),
                    mapBlock(146, 86, 96, 50, color: AppColors.mapPark),
                    mapBlock(12, 84, 96, 56),
                    mapBlock(150, 10, 92, 38),
                    const Positioned(
                      left: 153,
                      top: 44,
                      child: MapPin(icon: 'home'),
                    ),
                  ],
                ),
              ),
              Positioned(
                right: 12,
                bottom: 12,
                child: Tap(
                  onTap: onOpenMap,
                  child: Container(
                    height: 38,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x1F172B35),
                          blurRadius: 12,
                          offset: Offset(0, 4),
                        ),
                      ],
                    ),
                    child: Row(
                      children: [
                        const AppIcon(
                          'locate',
                          size: 15,
                          color: AppColors.primary,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          context.tr('useCurrent'),
                          style: ts(13, w: 600, c: AppColors.primary),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
