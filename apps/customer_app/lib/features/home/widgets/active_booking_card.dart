import 'package:flutter/material.dart';

import '../../../app/app_state.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';

/// Teal summary card for the booking in progress, shown at the top of Home.
class ActiveBookingCard extends StatelessWidget {
  const ActiveBookingCard({
    super.key,
    required this.state,
    required this.onTrack,
  });

  final AppState state;
  final VoidCallback onTrack;

  @override
  Widget build(BuildContext context) {
    final worker = state.worker;
    final stage = kStages[state.stage];
    final soft = Colors.white.withValues(alpha: .85);
    return ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: Container(
        color: AppColors.primary,
        padding: const EdgeInsets.all(18),
        child: Stack(
          children: [
            PositionedDirectional(
              top: -88,
              end: -68,
              child: Container(
                width: 180,
                height: 180,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: Colors.white.withValues(alpha: .06),
                    width: 28,
                  ),
                ),
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Flexible(
                      child: Text(
                        context.isAr
                            ? context.tr('activeBooking')
                            : context.tr('activeBooking').toUpperCase(),
                        style: ts(12, w: 700, c: soft, ls: 0.72),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: .14),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 7,
                            height: 7,
                            decoration: const BoxDecoration(
                              color: AppColors.gold,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            context.l(stage.label),
                            style: ts(12.5, w: 600, c: Colors.white),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Text(
                  context.l(state.service.name),
                  style: ts(19, w: 700, c: Colors.white),
                ),
                const SizedBox(height: 4),
                Text(state.whenLabel(context.isAr), style: ts(13.5, c: soft)),
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: .1),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Row(
                    children: [
                      InitialsTile(
                        context.l(worker.initials),
                        size: 42,
                        radius: 14,
                        bg: Colors.white,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    context.l(worker.name),
                                    style: ts(15, w: 600, c: Colors.white),
                                  ),
                                ),
                                const SizedBox(width: 5),
                                const AppIcon(
                                  'verified',
                                  size: 15,
                                  color: Colors.white,
                                ),
                              ],
                            ),
                            const SizedBox(height: 2),
                            RatingInline(
                              rating: worker.rating.toStringAsFixed(1),
                              trailing:
                                  ' · ${context.isAr ? '${worker.jobs} مهمة' : '${worker.jobs} jobs'}',
                              color: soft,
                              ratingColor: soft,
                              boldRating: false,
                            ),
                          ],
                        ),
                      ),
                      if (state.stage <= 3)
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              context.tr('eta'),
                              style: ts(
                                11.5,
                                c: Colors.white.withValues(alpha: .8),
                              ),
                            ),
                            Text(
                              context.isAr
                                  ? '${worker.etaMinutes} د'
                                  : '${worker.etaMinutes} min',
                              style: ts(18, w: 700, c: Colors.white),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                AppButton(
                  label: context.tr('trackWorker'),
                  kind: AppButtonKind.onTeal,
                  height: 48,
                  radius: 15,
                  fontSize: 15,
                  icon: 'locate',
                  onPressed: onTrack,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
