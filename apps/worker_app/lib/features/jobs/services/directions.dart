import 'package:url_launcher/url_launcher.dart';

/// The Google Maps "directions" link for a destination. It opens the Google Maps app when installed, otherwise the browser, and Apple devices
/// can open it in the browser too. No API key is involved: this is a plain link, not the Routes API.
Uri directionsUri(double latitude, double longitude) => Uri.https(
  'www.google.com',
  '/maps/dir/',
  {'api': '1', 'destination': '$latitude,$longitude', 'travelmode': 'driving'},
);

/// Valid, finite WGS84 coordinates.
bool validCoordinates(double? lat, double? lng) =>
    lat != null &&
    lng != null &&
    lat.isFinite &&
    lng.isFinite &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

/// Opens turn-by-turn directions. Returns false when nothing could handle the link, so the screen can say so.
abstract class DirectionsLauncher {
  Future<bool> open(double latitude, double longitude);
}

class UrlDirectionsLauncher implements DirectionsLauncher {
  const UrlDirectionsLauncher();

  @override
  Future<bool> open(double latitude, double longitude) async {
    if (!validCoordinates(latitude, longitude)) return false;
    try {
      return await launchUrl(
        directionsUri(latitude, longitude),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      return false;
    }
  }
}
