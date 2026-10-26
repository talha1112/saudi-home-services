import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart';

import '../../../app/router/app_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tiles.dart';
import '../widgets/call_sheet.dart';
import '../services/directions.dart';
import '../widgets/job_location_map.dart';

/// PROTOTYPE (demo builds only): a pretend accepted job with invented stages. The real screen is active_job_screen.dart.
/// The accepted job in progress: map, status, customer contact and the
/// stage button (start trip, arrived, start work, complete).
class DemoActiveJobScreen extends StatelessWidget {
  const DemoActiveJobScreen({
    super.key,
    this.directions = const UrlDirectionsLauncher(),
    this.mapBuilder,
    this.mapsEnabled,
  });

  /// Opens turn-by-turn directions (replaced in tests).
  final DirectionsLauncher directions;

  /// Replaces the Google map widget in tests (a platform view cannot run there).
  final Widget Function(LatLng target)? mapBuilder;

  /// Overrides "a Maps key was supplied" (tests).
  final bool? mapsEnabled;

  Future<void> _navigate(BuildContext context, BookingLocation? place) async {
    final messenger = ScaffoldMessenger.of(context);
    final lat = place?.latitude;
    final lng = place?.longitude;
    final String? problem;
    if (!validCoordinates(lat, lng)) {
      problem = context.tr('navNoLocation');
    } else if (!await directions.open(lat!, lng!)) {
      problem = context.mounted ? context.tr('navFailed') : null;
    } else {
      problem = null;
    }
    if (problem != null) {
      messenger.showSnackBar(SnackBar(content: Text(problem)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final ar = context.isAr;
    final r = app.request;
    final place = app.activeJobLocation;
    final top = MediaQuery.paddingOf(context).top;
    final stage = app.stage;
    return Scaffold(
      backgroundColor: Colors.white,
      body: Stack(
        children: [
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 330 + top,
            child: JobLocationMap(
              latitude: place?.latitude,
              longitude: place?.longitude,
              mapsEnabled: mapsEnabled,
              mapBuilder: mapBuilder ?? JobLocationMap.googleMap,
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
          PositionedDirectional(
            top: top + 6,
            end: 20,
            child: Semantics(
              label: context.tr('navigate'),
              button: true,
              child: SquareIconButton(
                key: const Key('navigate-button'),
                icon: 'locate',
                bg: AppColors.text,
                fg: Colors.white,
                bordered: false,
                shadow: true,
                onTap: () => _navigate(context, place),
              ),
            ),
          ),
          Positioned(
            top: 280 + top,
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
                child: Column(
                  children: [
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
                        children: [
                          const SheetHandle(),
                          const SizedBox(height: 14),
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
                                            text: '${context.l(r.service)} · ',
                                          ),
                                          TextSpan(
                                            text: 'HS-240871',
                                            style: ts(
                                              12.5,
                                              c: AppColors.slate,
                                              family: kLatinFont,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      context.l(kStages[stage]),
                                      style: ts(22, w: 700),
                                    ),
                                  ],
                                ),
                              ),
                              if (stage <= 1)
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
                                        style: ts(
                                          11,
                                          w: 600,
                                          c: AppColors.primary,
                                        ),
                                      ),
                                      Text(
                                        ar ? '12 د' : '12 min',
                                        style: ts(
                                          19,
                                          w: 800,
                                          c: AppColors.primary,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                          const SizedBox(height: 14),
                          Row(
                            children: [
                              for (var i = 0; i < kStages.length; i++) ...[
                                if (i > 0) const SizedBox(width: 4),
                                Expanded(
                                  child: Container(
                                    height: 5,
                                    decoration: BoxDecoration(
                                      color: i <= stage
                                          ? AppColors.primary
                                          : AppColors.line,
                                      borderRadius: BorderRadius.circular(3),
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                          const SizedBox(height: 14),
                          AppCard(
                            padding: const EdgeInsets.all(12),
                            radius: 18,
                            child: Row(
                              children: [
                                InitialsTile(
                                  context.l(r.initial),
                                  size: 46,
                                  fontSize: 16,
                                  radius: 15,
                                  bg: AppColors.chip,
                                  fg: AppColors.text,
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        context.l(r.customer),
                                        style: ts(15, w: 600),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        context.l(r.address!),
                                        style: ts(12.5, c: AppColors.slate),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 8),
                                SquareIconButton(
                                  icon: 'phone',
                                  iconSize: 19,
                                  bg: AppColors.tealTint,
                                  fg: AppColors.primary,
                                  bordered: false,
                                  onTap: () => showCallSheet(context),
                                ),
                                const SizedBox(width: 8),
                                SquareIconButton(
                                  icon: 'message',
                                  iconSize: 19,
                                  bg: AppColors.primary,
                                  fg: Colors.white,
                                  bordered: false,
                                  onTap: () => AppRouter.toChat(context),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 14),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 14,
                              vertical: 12,
                            ),
                            decoration: BoxDecoration(
                              color: AppColors.background,
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text(
                                  context.tr('agreedPrice'),
                                  style: ts(13.5, c: AppColors.slate),
                                ),
                                Flexible(
                                  child: Text.rich(
                                    TextSpan(
                                      style: ts(13.5, w: 700),
                                      children: [
                                        TextSpan(
                                          text: '${context.sar(app.gross)} · ',
                                        ),
                                        TextSpan(
                                          text:
                                              '${context.tr('youEarn')} ${context.sar(app.net)}',
                                          style: ts(
                                            13.5,
                                            w: 700,
                                            c: AppColors.primary,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (stage >= 4) ...[
                            const SizedBox(height: 14),
                            Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: AppColors.tealTint,
                                borderRadius: BorderRadius.circular(18),
                              ),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const AppIcon(
                                    'check',
                                    size: 20,
                                    color: AppColors.tealDeep,
                                    strokeWidth: 2.6,
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          context.tr('jobDoneT'),
                                          style: ts(
                                            15,
                                            w: 700,
                                            c: AppColors.tealDeep,
                                          ),
                                        ),
                                        const SizedBox(height: 3),
                                        Text(
                                          ar
                                              ? 'أُضيف ${context.sar(app.net)} إلى أرباحك المعلقة. سيُتاح خلال 48 ساعة.'
                                              : '${context.sar(app.net)} added to pending earnings. Available in 48 hours.',
                                          style: ts(
                                            13,
                                            c: AppColors.tealDeep,
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
                        ],
                      ),
                    ),
                    Container(
                      padding: EdgeInsets.fromLTRB(
                        20,
                        12,
                        20,
                        (context.bottomInset > 0 ? context.bottomInset : 12) +
                            12,
                      ),
                      decoration: const BoxDecoration(
                        border: Border(
                          top: BorderSide(color: AppColors.lineSoft),
                        ),
                      ),
                      child: AppButton(
                        label: context.l(kStageButtons[stage]),
                        background: stage == 3
                            ? AppColors.text
                            : AppColors.primary,
                        onPressed: () {
                          if (stage >= 4) {
                            AppRouter.toHomeTab(context);
                          } else {
                            app.update(() {
                              app.stage = stage + 1;
                              app.quoteState = QuoteState.accepted;
                            });
                          }
                        },
                      ),
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
