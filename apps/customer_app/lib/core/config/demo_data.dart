/// Opt-in prototype content: fake services, prices, ratings, workers, quotes, payment and tracking screens, and sample bookings.
///
/// Off by default, so a normal or release build never shows invented data or a pretend payment. Turn it on for design work with
/// `--dart-define=DEMO_DATA=true`. The real booking flow (catalog, cities, `POST /bookings`) never reads these fixtures.
const bool kDemoData = bool.fromEnvironment('DEMO_DATA');
