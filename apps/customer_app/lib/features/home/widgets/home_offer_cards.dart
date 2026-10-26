import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/coupon_code.dart';
import '../../../shared/components/ribbons.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';

/// Dark "20% off AC" promo card (270x150).
class DarkOfferCard extends StatelessWidget {
  const DarkOfferCard({super.key, required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: Container(
          width: 270,
          height: 150,
          color: AppColors.text,
          child: Stack(
            children: [
              Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 190),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              const AppIcon(
                                'snowflake',
                                size: 14,
                                color: AppColors.gold,
                              ),
                              const SizedBox(width: 6),
                              Text(
                                context.tr('catAc'),
                                style: ts(12, w: 600, c: AppColors.gold),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            context.tr('off1Title'),
                            style: ts(19, w: 700, c: Colors.white, h: 1.25),
                          ),
                        ],
                      ),
                    ),
                    Row(
                      children: [
                        AppIcon(
                          'clock',
                          size: 14,
                          color: Colors.white.withValues(alpha: .85),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          context.tr('off1Exp'),
                          style: ts(
                            12.5,
                            c: Colors.white.withValues(alpha: .85),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              CornerRibbon(context.tr('r20')),
            ],
          ),
        ),
      ),
    );
  }
}

/// Cream "first booking" promo card with a coupon code.
class FirstBookingOfferCard extends StatelessWidget {
  const FirstBookingOfferCard({super.key, required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onTap,
      child: Container(
        width: 270,
        height: 150,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: AppColors.cream,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: AppColors.creamBorder),
        ),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            HangingTag(
              context.tr('rFirst'),
              start: 0,
              top: -18,
              fontSize: 10.5,
              padding: const EdgeInsets.fromLTRB(10, 5, 10, 5),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('off2Title'),
                        style: ts(19, w: 700, h: 1.25),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        context.tr('off2Sub'),
                        style: ts(13, c: AppColors.slate),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                const CouponCode('HOME50'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
