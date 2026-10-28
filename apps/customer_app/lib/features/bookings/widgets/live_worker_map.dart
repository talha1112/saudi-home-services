import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/booking_scope.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/config/maps_config.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_icon.dart';
import '../logic/worker_position_controller.dart';

/// Builds the map showing the professional (and, when known, the place they are going to).
typedef LiveMapBuilder = Widget Function(LatLng worker, LatLng? destination);

/// The real Google map with a marker for the professional and one for the booking's address. The camera follows the professional.
Widget googleLiveMap(LatLng worker, LatLng? destination) =>
    _LiveGoogleMap(worker: worker, destination: destination);

class _LiveGoogleMap extends StatefulWidget {
  const _LiveGoogleMap({required this.worker, required this.destination});
  final LatLng worker;
  final LatLng? destination;

  @override
  State<_LiveGoogleMap> createState() => _LiveGoogleMapState();
}

class _LiveGoogleMapState extends State<_LiveGoogleMap> {
  GoogleMapController? _controller;

  @override
  void didUpdateWidget(_LiveGoogleMap old) {
    super.didUpdateWidget(old);
    if (old.worker != widget.worker) _follow();
  }

  void _follow() {
    final c = _controller;
    if (c == null) return;
    final d = widget.destination;
    if (d == null) {
      c.animateCamera(CameraUpdate.newLatLng(widget.worker));
    } else {
      final sw = LatLng(
        widget.worker.latitude < d.latitude
            ? widget.worker.latitude
            : d.latitude,
        widget.worker.longitude < d.longitude
            ? widget.worker.longitude
            : d.longitude,
      );
      final ne = LatLng(
        widget.worker.latitude > d.latitude
            ? widget.worker.latitude
            : d.latitude,
        widget.worker.longitude > d.longitude
            ? widget.worker.longitude
            : d.longitude,
      );
      c.animateCamera(
        CameraUpdate.newLatLngBounds(
          LatLngBounds(southwest: sw, northeast: ne),
          60,
        ),
      );
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GoogleMap(
      key: const Key('live-google-map'),
      initialCameraPosition: CameraPosition(target: widget.worker, zoom: 15),
      onMapCreated: (c) {
        _controller = c;
        _follow();
      },
      markers: {
        Marker(
          markerId: const MarkerId('worker'),
          position: widget.worker,
          icon: BitmapDescriptor.defaultMarkerWithHue(
            BitmapDescriptor.hueAzure,
          ),
        ),
        if (widget.destination != null)
          Marker(
            markerId: const MarkerId('destination'),
            position: widget.destination!,
          ),
      },
      zoomControlsEnabled: false,
      myLocationButtonEnabled: false,
      mapToolbarEnabled: false,
      compassEnabled: false,
      rotateGesturesEnabled: false,
      tiltGesturesEnabled: false,
    );
  }
}

/// "Your professional's location": the live map once they share, and an honest line when they do not.
class LiveWorkerMap extends StatefulWidget {
  const LiveWorkerMap({
    super.key,
    required this.bookingId,
    this.destination,
    this.mapBuilder = googleLiveMap,
    this.mapsEnabled,
    this.interval = const Duration(seconds: 5),
    this.controller,
  });

  final String bookingId;

  /// The position source, when the parent also needs it (it then owns and disposes it). Without one, the map makes its own.
  final WorkerPositionController? controller;

  /// The booking's own address, if it has an exact point.
  final LatLng? destination;
  final LiveMapBuilder mapBuilder;

  /// Overrides "a Maps key was supplied" (tests).
  final bool? mapsEnabled;
  final Duration interval;

  @override
  State<LiveWorkerMap> createState() => _LiveWorkerMapState();
}

class _LiveWorkerMapState extends State<LiveWorkerMap> {
  WorkerPositionController? _c;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _c ??=
        widget.controller ??
        (BookingScope.of(context).positionFor(widget.bookingId, widget.interval)
          ..start());
  }

  @override
  void dispose() {
    if (widget.controller == null) _c?.dispose();
    super.dispose();
  }

  String _ago(BuildContext context, Duration age) {
    final s = age.inSeconds;
    if (s < 20) return context.tr('bdLiveNow');
    if (s < 90) {
      return context
          .tr('bdLiveAgo')
          .replaceAll('{n}', '$s')
          .replaceAll('{u}', context.tr('bdSec'));
    }
    return context
        .tr('bdLiveAgo')
        .replaceAll('{n}', '${age.inMinutes}')
        .replaceAll('{u}', context.tr('bdMin'));
  }

  @override
  Widget build(BuildContext context) {
    final c = _c!;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final p = c.position;
        final age = c.age;
        final stale =
            age != null && age > const Duration(minutes: 2) ||
            (c.error != null && p != null);
        Widget body;
        String? caption;
        if (p != null && p.available) {
          final worker = LatLng(p.latitude!, p.longitude!);
          if (widget.mapsEnabled ?? mapsConfigured) {
            body = Directionality(
              textDirection: TextDirection.ltr,
              child: widget.mapBuilder(worker, widget.destination),
            );
          } else {
            body = _Note(icon: 'locate', text: context.tr('bdLiveNoMap'));
          }
          caption = age == null ? null : _ago(context, age);
        } else if (!c.loaded) {
          body = const Center(
            child: CircularProgressIndicator(strokeWidth: 2.4),
          );
        } else if (c.error != null && p == null) {
          body = _Note(icon: 'locate', text: context.tr('bdLiveError'));
        } else if (p?.reason == LiveLocationReason.noRecentPosition) {
          body = _Note(icon: 'locate', text: context.tr('bdLiveWaiting'));
        } else {
          body = _Note(icon: 'clock', text: context.tr('bdLiveNotYet'));
        }
        return Column(
          key: const Key('live-map'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(context.tr('bdLiveTitle'), style: ts(17, w: 700)),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: SizedBox(height: 220, child: body),
            ),
            if (caption != null) ...[
              const SizedBox(height: 6),
              Text(
                stale
                    ? context.tr('bdLiveStale').replaceAll('{t}', caption)
                    : caption,
                key: const Key('live-caption'),
                style: ts(12.5, c: stale ? AppColors.danger : AppColors.slate),
              ),
            ],
          ],
        );
      },
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.text});
  final String icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.tealTint,
      padding: const EdgeInsets.all(20),
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppIcon(icon, size: 26, color: AppColors.primary),
          const SizedBox(height: 10),
          Text(
            text,
            key: const Key('live-note'),
            textAlign: TextAlign.center,
            style: ts(13.5, c: AppColors.slate, h: 1.5),
          ),
        ],
      ),
    );
  }
}
