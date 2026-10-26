import 'package:flutter/material.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/map_mock.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../../dashboard/widgets/home_widgets.dart';

/// Details of a new job request, with "Submit quote" / "Decline".
class RequestScreen extends StatelessWidget {
  const RequestScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final r = kRequests.first;
    final ar = context.isAr;
    final top = MediaQuery.paddingOf(context).top;

    Widget infoTile(String icon, String label, String value) => Expanded(
      child: AppCard(
        padding: const EdgeInsets.all(12),
        radius: 16,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppIcon(icon, size: 17, color: AppColors.primary),
            const SizedBox(height: 4),
            Text(label, style: ts(12, c: AppColors.slate)),
            const SizedBox(height: 4),
            Text(value, style: ts(14, w: 600)),
          ],
        ),
      ),
    );

    return Scaffold(
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                SizedBox(
                  height: 170 + top,
                  child: Stack(
                    children: [
                      Positioned.fill(
                        child: Directionality(
                          textDirection: TextDirection.ltr,
                          child: MapCanvas(
                            width: 390,
                            height: 170,
                            children: [
                              mapRoad(top: 70, left: 0, right: 0, h: 14),
                              mapRoad(left: 110, top: 0, bottom: 0, w: 12),
                              mapRoad(left: 280, top: 0, bottom: 0, w: 10),
                              mapBlock(
                                140,
                                98,
                                120,
                                60,
                                color: AppColors.mapPark,
                                radius: 10,
                              ),
                              mapBlock(140, 10, 120, 46, radius: 10),
                              const Positioned(
                                left: 200,
                                top: 52,
                                child: MapPin(
                                  icon: 'home',
                                  size: 40,
                                  color: AppColors.text,
                                  iconSize: 18,
                                ),
                              ),
                            ],
                          ),
                        ),
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
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text.rich(
                                  TextSpan(
                                    style: ts(12.5, c: AppColors.slate),
                                    children: [
                                      TextSpan(
                                        text: '${context.tr('newRequest')} · ',
                                      ),
                                      TextSpan(
                                        text: '#REQ-58213',
                                        style: ts(
                                          12.5,
                                          c: AppColors.slate,
                                          family: kLatinFont,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 5),
                                Text(
                                  context.l(r.service),
                                  style: ts(23, w: 700),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          TimerPill(
                            r.timer,
                            size: 12.5,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 9,
                              vertical: 6,
                            ),
                            radius: 10,
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      IntrinsicHeight(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            infoTile(
                              'calendar',
                              context.tr('schedule'),
                              context.l(r.when),
                            ),
                            const SizedBox(width: 10),
                            infoTile(
                              'pin',
                              context.tr('location'),
                              '${context.l(r.area)} · ${ar ? '${r.distanceKm} كم' : '${r.distanceKm} km'}',
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      AppCard(
                        padding: const EdgeInsets.all(14),
                        radius: 18,
                        child: Row(
                          children: [
                            InitialsTile(
                              context.l(r.initial),
                              size: 44,
                              fontSize: 16,
                              radius: 14,
                              bg: AppColors.chip,
                              fg: AppColors.text,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    context.l(r.customer),
                                    style: ts(15, w: 600),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    context.tr('custSince'),
                                    style: ts(12.5, c: AppColors.slate),
                                  ),
                                ],
                              ),
                            ),
                            const RatingInline(
                              rating: '4.8',
                              size: 13,
                              fontSize: 13,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(context.tr('issue'), style: ts(16, w: 700)),
                      const SizedBox(height: 10),
                      AppCard(
                        padding: const EdgeInsets.all(14),
                        radius: 16,
                        child: Text(
                          context.l(r.description!),
                          style: ts(14.5, h: 1.55),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          for (var i = 0; i < 2; i++) ...[
                            if (i > 0) const SizedBox(width: 10),
                            Container(
                              width: 84,
                              height: 84,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: AppColors.mapBase,
                                borderRadius: BorderRadius.circular(14),
                              ),
                              child: const AppIcon(
                                'image',
                                size: 24,
                                color: AppColors.slate,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(18),
                          border: Border.all(
                            color: AppColors.tealSoftBorder,
                            width: 1.5,
                          ),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const IconTile(
                              'info',
                              size: 36,
                              radius: 12,
                              iconSize: 18,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    context.tr('minCharge'),
                                    style: ts(13, w: 600, c: AppColors.slate),
                                  ),
                                  const SizedBox(height: 3),
                                  Text(
                                    context.sar(kMinCharge),
                                    style: ts(19, w: 700),
                                  ),
                                  const SizedBox(height: 3),
                                  Text(
                                    context.tr('minChargeW'),
                                    style: ts(
                                      12.5,
                                      c: AppColors.slate,
                                      h: 1.45,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          BottomBar(
            child: Row(
              children: [
                AppButton(
                  label: context.tr('decline'),
                  kind: AppButtonKind.outline,
                  expand: false,
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: AppButton(
                    label: context.tr('submitQuote'),
                    onPressed: () => AppRouter.toQuote(context),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
