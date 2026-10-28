import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:hs_client/hs_client.dart';

import '../features/booking/logic/booking_submitter.dart';
import '../features/bookings/logic/booking_detail_controller.dart';
import '../features/bookings/logic/worker_position_controller.dart';
import '../features/messages/widgets/chat_target.dart';
import '../features/bookings/my_bookings_controller.dart';
import '../features/catalog/catalog_controller.dart';
import '../features/onboarding/screens/splash_screen.dart';
import '../features/location/services/device_location.dart';
import 'app_scope.dart';
import 'booking_scope.dart';
import 'auth_scope.dart';
import 'app_state.dart';
import 'localization/app_strings.dart';
import 'router/app_router.dart';
import 'theme/app_theme.dart';

class App extends StatefulWidget {
  const App({
    super.key,
    required this.client,
    this.deviceLocation = const GeolocatorDeviceLocation(),
  });

  /// Backend client, Firebase phone sign-in and push registration (created in main()).
  final HsClient client;

  /// The phone's location permission and position (replaced in tests).
  final DeviceLocation deviceLocation;

  @override
  State<App> createState() => _AppState();
}

class _AppState extends State<App> {
  final AppState _state = AppState();
  late final BookingServices _booking = BookingServices(
    catalog: CatalogController(load: widget.client.api.catalog),
    submitter: BookingSubmitter(
      api: widget.client.api,
      auth: widget.client.auth,
    ),
    bookings: MyBookingsController(
      api: widget.client.api,
      auth: widget.client.auth,
    ),
    detailFor: (id) => BookingDetailController(
      api: widget.client.api,
      auth: widget.client.auth,
      bookingId: id,
    ),
    positionFor: (id, interval) => WorkerPositionController(
      api: widget.client.api,
      auth: widget.client.auth,
      bookingId: id,
      interval: interval,
    ),
    notifications: NotificationsController(
      api: widget.client.api,
      auth: widget.client.auth,
    ),
    offers: OffersController(api: widget.client.api, auth: widget.client.auth),
    openFromNotification: _openFromPush,
  );

  final GlobalKey<NavigatorState> _navigator = GlobalKey<NavigatorState>();
  final GlobalKey<ScaffoldMessengerState> _messenger =
      GlobalKey<ScaffoldMessengerState>();
  StreamSubscription<PushEvent>? _pushForeground;
  StreamSubscription<PushEvent>? _pushOpened;

  String? _syncedLocale;

  /// Tells the server which language the app is in, so notifications are written in it (sent again after every sign-in).
  void _languageChanged() {
    final locale = _state.isArabic ? 'AR' : 'EN';
    if (locale == _syncedLocale) return;
    _syncedLocale = locale;
    unawaited(widget.client.auth.syncLocale(locale));
  }

  bool _askedLocation = false;

  /// Once signed in, asks the phone for location permission, so the map can start at the customer's place. Saying no is fine: the address
  /// can always be searched or the pin moved by hand.
  void _askLocation() {
    if (_askedLocation || !widget.client.auth.isSignedIn) return;
    _askedLocation = true;
    unawaited(widget.deviceLocation.request());
  }

  @override
  void initState() {
    super.initState();
    _state.addListener(_languageChanged);
    _languageChanged();
    widget.client.auth.addListener(_askLocation);
    _askLocation();
    // The catalog is public: load it up front so services and cities are ready by the time the customer is signed in.
    _booking.catalog.load();
    _pushForeground = widget.client.push.foreground.listen(_onPushInApp);
    _pushOpened = widget.client.push.opened.listen(_onPushTapped);
  }

  /// A push arrived while the app is open (the system shows nothing then): refresh the bookings and tell the customer, with a way in.
  void _onPushInApp(PushEvent e) {
    // Whatever it is about, the bell has one more.
    unawaited(_booking.notifications.refreshUnread());
    if (!e.isBooking) return;
    unawaited(_booking.bookings.load());
    final text = [
      e.title,
      e.body,
    ].whereType<String>().where((t) => t.isNotEmpty).join('\n');
    if (text.isEmpty) return;
    _messenger.currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          key: const Key('push-snackbar'),
          content: Text(text),
          action: SnackBarAction(
            label: kStrings['pushOpen']!.of(_state.isArabic),
            onPressed: () => unawaited(_openFromPush(e)),
          ),
        ),
      );
  }

  void _onPushTapped(PushEvent e) {
    if (e.isBooking) unawaited(_booking.bookings.load());
    unawaited(_openFromPush(e));
  }

  /// A message opens that booking's chat; every other step of a booking (a quote, payment, the work, a cancellation) opens the booking.
  Future<void> _openFromPush(PushEvent e) async {
    if (!e.isBooking || !widget.client.auth.isSignedIn) return;
    if (_overlay() == null) return;
    final id = e.resourceId!;
    final arabic = _state.isArabic;
    if (!e.isChat) {
      AppRouter.toBookingDetail(_overlay()!, id);
      return;
    }
    try {
      final d = await widget.client.auth.authorized(
        (t) => widget.client.api.bookingDetail(t, id),
      );
      final here = _overlay();
      if (here == null || !here.mounted) return;
      AppRouter.toChat(
        here,
        target: ChatTarget(
          bookingId: d.id,
          peerName:
              d.worker?.name(arabic: arabic) ??
              kStrings['bdWorker']!.of(arabic),
          subtitle: d.serviceName(arabic: arabic),
          peerPhone: d.worker?.phone,
        ),
      );
    } on ApiException {
      final here = _overlay();
      if (here != null && here.mounted) AppRouter.toBookingDetail(here, id);
    }
  }

  /// A context below the navigator, for opening screens from outside the widget tree.
  BuildContext? _overlay() => _navigator.currentState?.overlay?.context;

  @override
  void dispose() {
    unawaited(_pushForeground?.cancel());
    unawaited(_pushOpened?.cancel());
    _booking.catalog.dispose();
    _booking.submitter.dispose();
    _booking.bookings.dispose();
    widget.client.auth.removeListener(_askLocation);
    _state.removeListener(_languageChanged);
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AuthScope(
      controller: widget.client.auth,
      child: BookingScope(
        services: _booking,
        child: AppScope(
          state: _state,
          child: ListenableBuilder(
            listenable: _state,
            builder: (context, _) {
              final arabic = _state.isArabic;
              return MaterialApp(
                navigatorKey: _navigator,
                scaffoldMessengerKey: _messenger,
                debugShowCheckedModeBanner: false,
                title: arabic ? 'خدمات المنزل' : 'Home Services',
                theme: AppTheme.of(arabic: arabic),
                locale: Locale(arabic ? 'ar' : 'en'),
                supportedLocales: const [Locale('en'), Locale('ar')],
                localizationsDelegates: const [
                  GlobalMaterialLocalizations.delegate,
                  GlobalWidgetsLocalizations.delegate,
                  GlobalCupertinoLocalizations.delegate,
                ],
                home: const SplashScreen(),
              );
            },
          ),
        ),
      ),
    );
  }
}
