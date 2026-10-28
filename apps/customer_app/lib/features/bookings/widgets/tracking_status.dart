import 'dart:math';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/models/mock_data.dart';
import '../../booking/logic/booking_schedule.dart';
import '../../tracking/widgets/status_timeline.dart';
import '../logic/worker_position_controller.dart';

/// The last stage of the booking's journey (an index of [kStages]), from what the server reports: the status, the arrival time and whether
/// the professional is sharing a position. Nothing here moves on its own: every stage is a fact the server gave.
int trackingStage(BookingDetail d, {required bool sharing}) {
  switch (d.status) {
    case 'COMPLETED':
      return 6;
    case 'IN_PROGRESS':
      return 5;
    default:
      if (d.arrivedAt != null) return 4;
      return sharing ? 3 : 2;
  }
}

/// Straight-line minutes from the professional to the address (with a detour allowance, at city speed). An estimate, and only shown when
/// both points are known.
int? etaMinutes(LatLng? from, LatLng? to) {
  if (from == null || to == null) return null;
  const earth = 6371.0;
  double rad(double d) => d * pi / 180;
  final dLat = rad(to.latitude - from.latitude);
  final dLng = rad(to.longitude - from.longitude);
  final a =
      pow(sin(dLat / 2), 2) +
      cos(rad(from.latitude)) * cos(rad(to.latitude)) * pow(sin(dLng / 2), 2);
  final km = 2 * earth * asin(sqrt(a.toDouble()));
  const detour = 1.3;
  const kmPerHour = 30.0;
  return max(1, (km * detour / kmPerHour * 60).ceil());
}

/// "Booking status" with the ETA, the progress bars and the timeline of a paid booking.
class TrackingStatus extends StatelessWidget {
  const TrackingStatus({
    super.key,
    required this.detail,
    required this.position,
    this.destination,
  });

  final BookingDetail detail;
  final WorkerPositionController position;

  /// The booking's own address, when it has an exact point.
  final LatLng? destination;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    return ListenableBuilder(
      listenable: position,
      builder: (context, _) {
        final p = position.position;
        final sharing = p != null && p.available;
        final stage = trackingStage(detail, sharing: sharing);
        final minutes = stage == 3 && sharing
            ? etaMinutes(LatLng(p.latitude!, p.longitude!), destination)
            : null;
        final times = <DateTime?>[
          detail.when('BOOKING_CREATED'),
          detail.when('QUOTE_ACCEPTED'),
          detail.when('PAYMENT_CONFIRMED'),
          null, // "on the way" is not an event the server records
          detail.arrivedAt,
          detail.when('WORK_STARTED'),
          detail.when('WORK_COMPLETED'),
        ];
        return Column(
          key: const Key('tracking-status'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
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
                        key: const Key('tracking-stage'),
                        style: ts(22, w: 700),
                      ),
                    ],
                  ),
                ),
                if (minutes != null)
                  Container(
                    key: const Key('tracking-eta'),
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
                          context.tr('bdEtaMin').replaceAll('{n}', '$minutes'),
                          style: ts(20, w: 800, c: AppColors.primary),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
            if (minutes != null) ...[
              const SizedBox(height: 6),
              Text(context.tr('bdEtaNote'), style: ts(12, c: AppColors.slate)),
            ],
            const SizedBox(height: 16),
            StageBars(stage: stage),
            const SizedBox(height: 16),
            StatusTimeline(
              stage: stage,
              times: [for (final t in times) t == null ? '' : _clock(t, ar)],
            ),
          ],
        );
      },
    );
  }
}

/// "5:47 PM", in Saudi time.
String _clock(DateTime at, bool ar) {
  final t = saudiNow(at);
  final h12 = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final suffix = t.hour < 12 ? (ar ? 'ص' : 'AM') : (ar ? 'م' : 'PM');
  return '$h12:${t.minute.toString().padLeft(2, '0')} $suffix';
}
