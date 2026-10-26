import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/coupon_code.dart';
import '../../../shared/components/ribbons.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';

/// Large dark "20% off AC deep cleaning" offer.
class AcOfferCard extends StatelessWidget {
  const AcOfferCard({super.key, required this.onBook});
  final VoidCallback onBook;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: Container(
        color: AppColors.text,
        child: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const AppIcon(
                        'snowflake',
                        size: 15,
                        color: AppColors.gold,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        context.tr('catAc'),
                        style: ts(12.5, w: 600, c: AppColors.gold),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 240),
                    child: Text(
                      context.tr('off1Title'),
                      style: ts(24, w: 700, c: Colors.white, h: 1.2),
                    ),
                  ),
                  const SizedBox(height: 14),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 270),
                    child: Text(
                      context.tr('off1Desc'),
                      style: ts(
                        13.5,
                        c: Colors.white.withValues(alpha: .8),
                        h: 1.5,
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            context.tr('code'),
                            style: ts(
                              11.5,
                              c: Colors.white.withValues(alpha: .7),
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'AC20',
                            style: ts(
                              14,
                              w: 700,
                              c: Colors.white,
                              family: kLatinFont,
                              ls: 1.1,
                            ),
                          ),
                        ],
                      ),
                      AppButton(
                        label: context.tr('bookNow'),
                        kind: AppButtonKind.gold,
                        height: 44,
                        radius: 14,
                        fontSize: 15,
                        weight: 700,
                        expand: false,
                        padding: const EdgeInsets.symmetric(horizontal: 18),
                        onPressed: onBook,
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Text(
                    '${context.tr('off1Exp')} · ${context.tr('terms')}',
                    style: ts(11.5, c: Colors.white.withValues(alpha: .65)),
                  ),
                ],
              ),
            ),
            CornerRibbon(
              context.tr('r20'),
              top: 24,
              end: -40,
              width: 160,
              vertical: 6,
              fontSize: 12,
            ),
          ],
        ),
      ),
    );
  }
}

/// Cream "save SAR 50 on your first booking" offer with a coupon.
class FirstBookingBigCard extends StatelessWidget {
  const FirstBookingBigCard({super.key, required this.onBook});
  final VoidCallback onBook;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cream,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.creamBorder),
      ),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 30, 20, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        context.tr('off2Title'),
                        style: ts(21, w: 700, h: 1.25),
                      ),
                    ),
                    const SizedBox(width: 12),
                    const IconTile(
                      'gift',
                      size: 64,
                      radius: 20,
                      iconSize: 28,
                      bg: Colors.white,
                      fg: Color(0xFFB07A10),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  context.tr('off2Sub'),
                  style: ts(13.5, c: AppColors.slate),
                ),
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const CouponCode(
                      'HOME50',
                      fontSize: 13,
                      padding: EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      radius: 10,
                    ),
                    AppButton(
                      label: context.tr('bookNow'),
                      height: 42,
                      radius: 13,
                      fontSize: 15,
                      expand: false,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      onPressed: onBook,
                    ),
                  ],
                ),
              ],
            ),
          ),
          HangingTag(
            context.tr('rFirst'),
            start: 20,
            top: 0,
            fontSize: 11,
            radius: 10,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          ),
        ],
      ),
    );
  }
}

/// White "limited time" offer with a dark header strip and was/now price.
class LimitedOfferCard extends StatelessWidget {
  const LimitedOfferCard({super.key, required this.onBook});
  final VoidCallback onBook;

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
            color: AppColors.text,
            child: Row(
              children: [
                const AppIcon('clock', size: 14, color: AppColors.gold),
                const SizedBox(width: 8),
                Text(
                  '${context.tr('limited')} • ${context.tr('endsToday')}',
                  style: ts(11.5, w: 800, c: AppColors.gold, ls: 0.69),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                const IconTile('zap', size: 56, radius: 17, iconSize: 26),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        context.tr('off3Title'),
                        style: ts(16, w: 700, h: 1.3),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${context.tr('catElec')} · ${context.tr('riyadhJeddah')}',
                        style: ts(12.5, c: AppColors.slate),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(context.sar(69), style: ts(19, w: 700)),
                    const SizedBox(width: 8),
                    Text(
                      context.sar(99),
                      style: ts(
                        13,
                        c: AppColors.slate,
                        deco: TextDecoration.lineThrough,
                      ),
                    ),
                  ],
                ),
                AppButton(
                  label: context.tr('bookNow'),
                  height: 42,
                  radius: 13,
                  fontSize: 15,
                  expand: false,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  onPressed: onBook,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// "New offer" plumbing card.
class NewOfferCard extends StatelessWidget {
  const NewOfferCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: AppColors.lineSoft),
          ),
          child: Row(
            children: [
              const IconTile('droplet', size: 56, radius: 17, iconSize: 26),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsetsDirectional.only(end: 70),
                      child: Text(
                        context.tr('off4Title'),
                        style: ts(16, w: 700),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Pill(
                          context.tr('r15'),
                          bg: AppColors.gold,
                          fg: AppColors.text,
                          fontSize: 11,
                          weight: 800,
                          radius: 7,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 3,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            '${context.tr('catPlumb')} · ${context.tr('validUntil')}',
                            style: ts(12.5, c: AppColors.slate),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        HangingTag(
          context.tr('newOffer'),
          end: 16,
          bg: AppColors.primary,
          fg: Colors.white,
        ),
      ],
    );
  }
}

/// An offer an administrator published, drawn like the prototype offers: the title, the text, the ribbon text, and when it ends.
class RealOfferCard extends StatelessWidget {
  const RealOfferCard({
    super.key,
    required this.offer,
    required this.serviceName,
    required this.endsLabel,
    required this.onBook,
  });

  final OfferItem offer;

  /// The service the offer is about, if it is about one.
  final String? serviceName;
  final String endsLabel;
  final VoidCallback onBook;

  @override
  Widget build(BuildContext context) {
    final ribbon = offer.terms.trim();
    final shortRibbon = ribbon.isNotEmpty && ribbon.length <= 14;
    return ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: Container(
        color: AppColors.text,
        child: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const AppIcon('gift', size: 15, color: AppColors.gold),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          serviceName ?? context.tr('offers'),
                          style: ts(12.5, w: 600, c: AppColors.gold),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 240),
                    child: Text(
                      offer.title,
                      style: ts(24, w: 700, c: Colors.white, h: 1.2),
                    ),
                  ),
                  if (offer.description.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 270),
                      child: Text(
                        offer.description,
                        style: ts(
                          13.5,
                          c: Colors.white.withValues(alpha: .8),
                          h: 1.5,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 18),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        label: context.tr('bookNow'),
                        kind: AppButtonKind.gold,
                        height: 44,
                        radius: 14,
                        fontSize: 15,
                        weight: 700,
                        expand: false,
                        padding: const EdgeInsets.symmetric(horizontal: 18),
                        onPressed: onBook,
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Text(
                    [
                      endsLabel,
                      if (ribbon.isNotEmpty && !shortRibbon) ribbon,
                    ].join(' · '),
                    style: ts(11.5, c: Colors.white.withValues(alpha: .65)),
                  ),
                ],
              ),
            ),
            if (shortRibbon)
              CornerRibbon(
                ribbon,
                top: 24,
                end: -40,
                width: 160,
                vertical: 6,
                fontSize: 12,
              ),
          ],
        ),
      ),
    );
  }
}
