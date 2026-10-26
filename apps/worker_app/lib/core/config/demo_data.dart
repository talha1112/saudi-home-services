import 'package:flutter/foundation.dart';

/// Opt-in prototype content for design work: invented requests, customers, distances, earnings, ratings, chat and a pretend job with a fixed
/// address and map pin (`kRequests`, `devJobLocation`, the prototype quote and stage screens).
///
/// It needs BOTH a non-release build and `--dart-define=DEMO_DATA=true`. In a release build [kReleaseMode] is a compile-time constant, so
/// this is `false` whatever is passed and the prototype code is unreachable. The real flow (requests, quotes, assigned jobs) never reads
/// these fixtures.
const bool kDemoData = !kReleaseMode && bool.fromEnvironment('DEMO_DATA');
