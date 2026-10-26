import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/ribbons.dart';
import '../../../shared/models/service.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';

class ServiceListCard extends StatelessWidget {
  const ServiceListCard({
    super.key,
    required this.service,
    required this.onOpen,
    required this.onBook,
  });

  final Service service;
  final VoidCallback onOpen;
  final VoidCallback onBook;

  @override
  Widget build(BuildContext context) {
    return Tap(
      onTap: onOpen,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(22),
              border: Border.all(color: AppColors.lineSoft),
              boxShadow: kSoftShadow,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                IconTile(service.icon, size: 56, radius: 17, iconSize: 26),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsetsDirectional.only(end: 64),
                        child: Text(
                          context.l(service.name),
                          style: ts(16, w: 600),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        context.l(service.description),
                        style: ts(13, c: AppColors.slate, h: 1.45),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 10,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          if (service.rating != null)
                            RatingInline(
                              rating: service.rating!.toStringAsFixed(1),
                              trailing: service.reviews == null
                                  ? ''
                                  : '(${_thousands(service.reviews!)})',
                              size: 13,
                            ),
                          if (service.duration != null)
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const AppIcon(
                                  'clock',
                                  size: 13,
                                  color: AppColors.slate,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  context.l(service.duration!),
                                  style: ts(12.5, c: AppColors.slate),
                                ),
                              ],
                            ),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const AppIcon(
                                'verified',
                                size: 13,
                                color: AppColors.primary,
                              ),
                              const SizedBox(width: 4),
                              Text(
                                context.tr('verifiedPros'),
                                style: ts(12.5, w: 600, c: AppColors.primary),
                              ),
                            ],
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          if (service.price != null)
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  context.tr('minFrom'),
                                  style: ts(11.5, c: AppColors.slate),
                                ),
                                const SizedBox(height: 1),
                                Row(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.baseline,
                                  textBaseline: TextBaseline.alphabetic,
                                  children: [
                                    Text(
                                      context.sar(service.price!),
                                      style: ts(17, w: 700),
                                    ),
                                    if (service.was != null) ...[
                                      const SizedBox(width: 6),
                                      Text(
                                        context.sar(service.was!),
                                        style: ts(
                                          12.5,
                                          c: AppColors.slate,
                                          deco: TextDecoration.lineThrough,
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ],
                            )
                          else
                            const SizedBox.shrink(),
                          AppButton(
                            label: context.tr('book'),
                            height: 38,
                            radius: 12,
                            fontSize: 14,
                            expand: false,
                            padding: const EdgeInsets.symmetric(horizontal: 18),
                            onPressed: onBook,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (service.ribbon != null)
            HangingTag(
              context.l(service.ribbon!),
              end: 18,
              bg: service.ribbonGold ? AppColors.gold : AppColors.primary,
              fg: service.ribbonGold ? AppColors.text : Colors.white,
            ),
        ],
      ),
    );
  }
}

String _thousands(int n) {
  final s = n.toString();
  if (s.length <= 3) return s;
  return '${s.substring(0, s.length - 3)},${s.substring(s.length - 3)}';
}
