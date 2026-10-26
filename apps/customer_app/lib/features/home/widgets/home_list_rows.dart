import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/models/service.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/tiles.dart';

/// Compact service row: icon, name, rating and "from" price.
class RecommendedServiceRow extends StatelessWidget {
  const RecommendedServiceRow({
    super.key,
    required this.service,
    required this.onTap,
  });

  final Service service;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(12),
      radius: 18,
      onTap: onTap,
      child: Row(
        children: [
          IconTile(service.icon, size: 48, radius: 15, iconSize: 22),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  context.l(service.name),
                  style: ts(15, w: 600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 3),
                if (service.rating != null)
                  RatingInline(
                    rating: service.rating!.toStringAsFixed(1),
                    trailing: service.duration == null
                        ? ''
                        : ' · ${context.l(service.duration!)}',
                    boldRating: false,
                    ratingColor: AppColors.slate,
                  ),
              ],
            ),
          ),
          if (service.price != null) ...[
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(context.tr('from'), style: ts(11.5, c: AppColors.slate)),
                const SizedBox(height: 2),
                Text(context.sar(service.price!), style: ts(15, w: 700)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Past booking row with a "Book again" action.
class RecentBookingRow extends StatelessWidget {
  const RecentBookingRow({
    super.key,
    required this.service,
    required this.date,
    required this.worker,
    required this.onAgain,
  });

  final Service service;
  final String date;
  final String worker;
  final VoidCallback onAgain;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.all(12),
      radius: 18,
      child: Row(
        children: [
          IconTile(
            service.icon,
            size: 44,
            radius: 14,
            iconSize: 20,
            bg: AppColors.chip,
            fg: AppColors.slate,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  context.l(service.name),
                  style: ts(14.5, w: 600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 3),
                Text(
                  '$date · $worker',
                  style: ts(12.5, c: AppColors.slate),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          AppButton(
            label: context.tr('bookAgain'),
            kind: AppButtonKind.soft,
            height: 36,
            radius: 12,
            fontSize: 13,
            expand: false,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            onPressed: onAgain,
          ),
        ],
      ),
    );
  }
}
