/// Google Maps Platform key for the Places (New) and Geocoding REST calls. Supplied at build or run time, never stored in the source:
///
///   flutter run --dart-define-from-file=maps.local.json        (a git-ignored file: {"GOOGLE_MAPS_API_KEY": "..."})
///   flutter run --dart-define=GOOGLE_MAPS_API_KEY=...
///
/// The same value also configures the map itself: the Android build reads it from the dart-defines (see android/app/build.gradle.kts) and the
/// iOS build reads MAPS_API_KEY from ios/Flutter/Secrets.xcconfig (see docs/GOOGLE_MAPS_SETUP.md).
///
/// A key shipped in a mobile app can be extracted from the installed app. Restrict it (application and API restrictions) before release.
const String kMapsApiKey = String.fromEnvironment('GOOGLE_MAPS_API_KEY');

/// Whether a key was supplied. Without one the picker still opens but says the map is not set up, and search and address lookup are disabled.
bool get mapsConfigured => kMapsApiKey.isNotEmpty;
