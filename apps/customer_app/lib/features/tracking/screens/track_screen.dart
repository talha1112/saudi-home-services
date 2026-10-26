import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/models/mock_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/status_timeline.dart';
import '../widgets/tracking_map.dart';
import '../widgets/tracking_sheets.dart';

class TrackScreen extends StatelessWidget {
  const TrackScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final top = MediaQuery.paddingOf(context).top;
    final stage = app.stage;
    final worker = app.worker;
    final ar = context.isAr;
    return Scaffold(
      backgroundColor: Colors.white,
      body: Stack(
        children: [
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 380 + top,
            child: const TrackingMap(),
          ),
          PositionedDirectional(
            top: top + 6,
            start: 20,
            child: SquareIconButton.back(
              context,
              bordered: false,
              shadow: true,
            ),
          ),
          PositionedDirectional(
            top: top + 6,
            end: 20,
            child: Semantics(
              label: context.tr('support'),
              button: true,
              child: const SquareIconButton(
                icon: 'help',
                bordered: false,
                shadow: true,
              ),
            ),
          ),
          Positioned(
            top: 320 + top,
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
                boxShadow: [
                  BoxShadow(
                    color: Color(0x1A172B35),
                    blurRadius: 30,
                    offset: Offset(0, -8),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(28),
                ),
                child: ListView(
                  padding: EdgeInsets.fromLTRB(
                    20,
                    10,
                    20,
                    context.bottomInset + 20,
                  ),
                  children: [
                    const SheetHandle(),
                    const SizedBox(height: 16),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                context.tr('statusT'),
                                style: ts(12.5, c: AppColors.slate),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                context.l(kStages[stage].label),
                                style: ts(22, w: 700),
                              ),
                            ],
                          ),
                        ),
                        if (stage <= 3)
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 8,
                            ),
                            decoration: BoxDecoration(
                              color: AppColors.tealTint,
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: Column(
                              children: [
                                Text(
                                  context.tr('eta'),
                                  style: ts(11, w: 600, c: AppColors.primary),
                                ),
                                Text(
                                  ar
                                      ? '${worker.etaMinutes} د'
                                      : '${worker.etaMinutes} min',
                                  style: ts(20, w: 800, c: AppColors.primary),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    StageBars(stage: stage),
                    const SizedBox(height: 16),
                    _WorkerRow(),
                    if (app.isDone) ...[
                      const SizedBox(height: 16),
                      AppButton(
                        label: context.tr('rateNow'),
                        height: 54,
                        radius: 18,
                        leading: const AppIcon(
                          'star',
                          size: 18,
                          color: AppColors.gold,
                          filled: true,
                          strokeWidth: 0,
                        ),
                        onPressed: () => AppRouter.toRate(context),
                      ),
                    ],
                    const SizedBox(height: 16),
                    StatusTimeline(stage: stage),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Expanded(
                          child: AppButton(
                            label: context.tr('cancelBooking'),
                            kind: AppButtonKind.outline,
                            height: 48,
                            radius: 15,
                            fontSize: 14,
                            onPressed: () => showCancelSheet(context),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: AppButton(
                            label: context.tr('demoAdvance'),
                            kind: AppButtonKind.outline,
                            dashed: true,
                            height: 48,
                            radius: 15,
                            fontSize: 13.5,
                            onPressed: () => app.update(
                              () => app.stage = (app.stage + 1).clamp(0, 6),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _WorkerRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final worker = context.app.worker;
    return AppCard(
      padding: const EdgeInsets.all(12),
      radius: 18,
      child: Row(
        children: [
          InitialsTile(
            context.l(worker.initials),
            size: 50,
            fontSize: 17,
            radius: 16,
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
                        style: ts(15, w: 600),
                      ),
                    ),
                    const SizedBox(width: 5),
                    const AppIcon(
                      'verified',
                      size: 15,
                      color: AppColors.primary,
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                RatingInline(
                  rating: worker.rating.toStringAsFixed(1),
                  trailing: ' · ${context.tr('vehicle')}',
                  boldRating: false,
                  ratingColor: AppColors.slate,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SquareIconButton(
            icon: 'phone',
            size: 44,
            iconSize: 19,
            bg: AppColors.tealTint,
            fg: AppColors.primary,
            bordered: false,
            onTap: () => showCallSheet(context),
          ),
          const SizedBox(width: 8),
          Stack(
            clipBehavior: Clip.none,
            children: [
              SquareIconButton(
                icon: 'message',
                size: 44,
                iconSize: 19,
                bg: AppColors.primary,
                fg: Colors.white,
                bordered: false,
                onTap: () => AppRouter.toChat(context),
              ),
              PositionedDirectional(
                top: -4,
                end: -4,
                child: Container(
                  constraints: const BoxConstraints(minWidth: 18),
                  height: 18,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.gold,
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: Colors.white, width: 2),
                  ),
                  child: Text('1', style: ts(10.5, w: 800, family: kLatinFont)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
