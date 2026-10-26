import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

/// Backend API root, including the version. Supplied at build or run time:
///
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3001/api/v1            (debug; this is also the default)
///   flutter build apk --release --dart-define=API_BASE_URL=https://api.example.com/api/v1
///
/// Debug builds fall back to the Android emulator's alias for the development computer. Every other build REQUIRES an https address of a
/// real host and refuses to start otherwise (see [resolveApiBaseUrl]), so a release build can never silently point at the emulator host.
const String _configured = String.fromEnvironment('API_BASE_URL');

String apiBaseUrl() => resolveApiBaseUrl(_configured, isDebug: kDebugMode);
