import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../shared/components/dashed.dart';
import '../../../shared/widgets/app_icon.dart';

/// Circular illustration: dashed ring, hero icon tile and a gold badge.
class OnboardingIllustration extends StatelessWidget {
  const OnboardingIllustration({
    super.key,
    required this.icon,
    required this.badge,
  });

  final String icon;
  final String badge;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 270,
      height: 270,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: AppColors.tealTint,
        shape: BoxShape.circle,
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          const Positioned.fill(
            child: Padding(
              padding: EdgeInsets.all(28),
              child: DashedCircle(color: AppColors.tealBorder),
            ),
          ),
          Container(
            width: 128,
            height: 128,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(36),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x2E00695C),
                  blurRadius: 40,
                  offset: Offset(0, 18),
                ),
              ],
            ),
            child: AppIcon(
              icon,
              size: 56,
              color: AppColors.primary,
              strokeWidth: 1.8,
            ),
          ),
          PositionedDirectional(
            top: 44,
            end: 28,
            child: Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.gold,
                borderRadius: BorderRadius.circular(18),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x66F4B740),
                    blurRadius: 24,
                    offset: Offset(0, 10),
                  ),
                ],
              ),
              child: AppIcon(
                badge,
                size: 24,
                color: AppColors.text,
                strokeWidth: 2.2,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
