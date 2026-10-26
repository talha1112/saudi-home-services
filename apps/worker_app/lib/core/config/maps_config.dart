/// Google Maps Platform key. Supplied at build or run time, never stored in the source:
///
///   flutter run --dart-define-from-file=maps.local.json        (a git-ignored file: {"GOOGLE_MAPS_API_KEY": "..."})
///
/// The same value configures the map on Android (read by android/app/build.gradle.kts from the dart-defines) and iOS (MAPS_API_KEY in
/// ios/Flutter/Secrets.xcconfig). A key shipped in a mobile app can be extracted: restrict it before release (docs/GOOGLE_MAPS_SETUP.md).
const String kMapsApiKey = String.fromEnvironment('GOOGLE_MAPS_API_KEY');

/// Whether a key was supplied. Without one the job screens keep the illustrated map and directions still work (they open Google Maps).
bool get mapsConfigured => kMapsApiKey.isNotEmpty;
