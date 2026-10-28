import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:hs_client/hs_client.dart';

import '../features/onboarding/screens/welcome_screen.dart';
import '../features/jobs/logic/worker_jobs_controller.dart';
import '../features/quotes/logic/quote_submitter.dart';
import '../features/jobs/logic/position_sharer.dart';
import '../features/messages/widgets/chat_target.dart';
import 'localization/app_strings.dart';
import 'router/app_router.dart';
import 'app_scope.dart';
import 'jobs_scope.dart';
import '../features/verification/services/document_picker.dart';
import 'app_state.dart';
import 'auth_scope.dart';
import 'onboarding_scope.dart';
import 'theme/app_theme.dart';

class App extends StatefulWidget {
  const App({
    super.key,
    required this.client,
    this.documentPicker = const SystemDocumentPicker(),
    this.positionSource = const GeolocatorPositionSource(),
  });

  /// Backend client, Firebase phone sign-in and push registration (created in main()).
  final HsClient client;

  /// How documents are chosen (the system chooser; tests pass a fake).
  final DocumentPicker documentPicker;

  /// The phone's location (tests pass a fake).
  final PositionSource positionSource;

  @override
  State<App> createState() => _AppState();
}

class _AppState extends State<App> with WidgetsBindingObserver {
  final AppState _state = AppState();
  late final WorkerJobsController _jobs = WorkerJobsController(
    api: widget.client.api,
    auth: widget.client.auth,
  );
  late final QuoteSubmitter _quotes = QuoteSubmitter(
    api: widget.client.api,
    auth: widget.client.auth,
    jobs: _jobs,
  );

  late final PositionSharer _sharer = PositionSharer(
    api: widget.client.api,
    auth: widget.client.auth,
    jobs: _jobs,
    source: widget.positionSource,
  );

  late final JobsServices _services = JobsServices(
    jobs: _jobs,
    quotes: _quotes,
    sharer: _sharer,
    notifications: NotificationsController(
      api: widget.client.api,
      auth: widget.client.auth,
    ),
    reviews: ReviewsController(
      api: widget.client.api,
      auth: widget.client.auth,
    ),
    presence: PresenceController(
      api: widget.client.api,
      auth: widget.client.auth,
    ),
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

  @override
  void initState() {
    super.initState();
    _state.addListener(_languageChanged);
    _languageChanged();
    WidgetsBinding.instance.addObserver(this);
    widget.client.auth.addListener(_authChanged);
    _authChanged();
    _pushForeground = widget.client.push.foreground.listen(_onPushInApp);
    _pushOpened = widget.client.push.opened.listen(_onPushTapped);
  }

  void _authChanged() {
    if (widget.client.auth.isSignedIn) {
      _sharer.start();
    } else {
      _sharer.stop();
      _sharer.reset();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _sharer.setForeground(state == AppLifecycleState.resumed);
  }

  /// A push arrived while the app is open (the system shows nothing then): refresh what it is about and tell the worker, with a way in.
  void _onPushInApp(PushEvent e) {
    // Whatever it is about, the notification list has one more.
    unawaited(_services.notifications.refreshUnread());
    if (e.isVerification) widget.client.onboarding.refresh(force: true);
    if (e.isBooking) {
      unawaited(
        _jobs.refresh(),
      ); // a new request, a decision on a quote, payment, a cancellation: the lists change
    }
    if (!e.isVerification && !e.isSupportReply && !e.isBooking) return;
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
            label: kStrings['wjOpen']!.of(_state.isArabic),
            onPressed: () => _openFromPush(e),
          ),
        ),
      );
  }

  /// The worker tapped a push shown by the system.
  void _onPushTapped(PushEvent e) {
    if (e.isVerification) widget.client.onboarding.refresh(force: true);
    _openFromPush(e);
  }

  /// Where a push leads: support replies to the conversation, decisions on the application to the status screen, a message to that
  /// booking's chat, a new request to its details, and every other step of a booking to the job (or the job list when it is not ours).
  Future<void> _openFromPush(PushEvent e) async {
    if (_overlay() == null || !widget.client.auth.isSignedIn) return;
    if (e.isSupportReply) {
      AppRouter.toSupport(_overlay()!);
    } else if (e.isVerification) {
      AppRouter.toStatus(_overlay()!);
    } else if (e.isBooking) {
      final id = e.resourceId!;
      final arabic = _state.isArabic;
      try {
        if (e.type == 'request.new' ||
            e.type == 'quote.rejected' ||
            e.type == 'quote.change_requested') {
          final request = await _jobs.requestDetail(id);
          final here = _overlay();
          if (here != null && here.mounted) {
            AppRouter.toRequestDetail(here, request);
          }
        } else {
          final job = await _jobs.reloadJob(id);
          final here = _overlay();
          if (here == null || !here.mounted) return;
          if (e.isChat) {
            AppRouter.toChat(
              here,
              target: ChatTarget(
                bookingId: job.id,
                peerName:
                    job.customerName ?? kStrings['wjCustomer']!.of(arabic),
                subtitle: job.service.name(arabic: arabic),
                peerPhone: job.customerPhone,
              ),
            );
          } else {
            AppRouter.toJob(here, id);
          }
        }
      } on ApiException {
        // not ours any more (or no connection): the job list is the honest place to land
        final here = _overlay();
        if (here != null && here.mounted) AppRouter.toJobsTab(here, tab: 0);
      }
    }
  }

  /// A context below the navigator, for opening screens from outside the widget tree.
  BuildContext? _overlay() => _navigator.currentState?.overlay?.context;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.client.auth.removeListener(_authChanged);
    _sharer.dispose();
    unawaited(_pushForeground?.cancel());
    unawaited(_pushOpened?.cancel());
    _quotes.dispose();
    _services.presence.dispose();
    _jobs.dispose();
    _state.removeListener(_languageChanged);
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AuthScope(
      controller: widget.client.auth,
      child: OnboardingScope(
        controller: widget.client.onboarding,
        child: DocumentPickerScope(
          picker: widget.documentPicker,
          child: JobsScope(
            services: _services,
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
                    title: arabic
                        ? 'خدمات المنزل للفنيين'
                        : 'Home Services Pro',
                    theme: AppTheme.of(arabic: arabic),
                    locale: Locale(arabic ? 'ar' : 'en'),
                    supportedLocales: const [Locale('en'), Locale('ar')],
                    localizationsDelegates: const [
                      GlobalMaterialLocalizations.delegate,
                      GlobalWidgetsLocalizations.delegate,
                      GlobalCupertinoLocalizations.delegate,
                    ],
                    home: const WelcomeScreen(showLanguage: true),
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }
}
