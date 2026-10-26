import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../../core/config/maps_config.dart';
import '../services/directions.dart';
import 'job_map.dart';

/// The confirmed job's place on a real Google map, with the exact pin. Shown only for a CONFIRMED booking: before that the backend gives the
/// worker only the city and district, so request screens keep the area-level illustration.
///
/// Falls back to the illustrated map when no Maps key is configured or the job has no valid coordinates, so the screen never breaks.
class JobLocationMap extends StatelessWidget {
  const JobLocationMap({
    super.key,
    this.latitude,
    this.longitude,
    this.mapBuilder = googleMap,
    this.mapsEnabled,
  });

  final double? latitude;
  final double? longitude;

  /// Builds the map widget; tests replace it because a platform view cannot run in widget tests.
  final Widget Function(LatLng target) mapBuilder;

  /// Overrides "a Maps key was supplied" (tests).
  final bool? mapsEnabled;

  /// The real map: a marker on the job's place, no rotate/tilt, none of Google's extra buttons.
  static Widget googleMap(LatLng target) => GoogleMap(
    key: const Key('job-google-map'),
    initialCameraPosition: CameraPosition(target: target, zoom: 16),
    markers: {Marker(markerId: const MarkerId('job'), position: target)},
    zoomControlsEnabled: false,
    myLocationButtonEnabled: false,
    mapToolbarEnabled: false,
    compassEnabled: false,
    rotateGesturesEnabled: false,
    tiltGesturesEnabled: false,
  );

  @override
  Widget build(BuildContext context) {
    if (!(mapsEnabled ?? mapsConfigured) ||
        !validCoordinates(latitude, longitude)) {
      return const JobMap();
    }
    return Directionality(
      textDirection: TextDirection.ltr, // maps are not mirrored
      child: mapBuilder(LatLng(latitude!, longitude!)),
    );
  }
}
