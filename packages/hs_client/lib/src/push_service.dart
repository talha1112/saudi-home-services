import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'storage.dart';

/// A push message as the app sees it: what the backend put in its `data` map (no personal data) plus the visible title and body.
class PushEvent {
  const PushEvent({this.notificationId, this.type, this.resourceType, this.resourceId, this.title, this.body});

  factory PushEvent.fromData(Map<String, dynamic> data, {String? title, String? body}) => PushEvent(
    notificationId: data['notificationId'] as String?,
    type: data['type'] as String?,
    resourceType: data['resourceType'] as String?,
    resourceId: data['resourceId'] as String?,
    title: title,
    body: body,
  );

  /// The backend's notification id; the same push delivered twice carries the same one.
  final String? notificationId;

  /// The template key, for example `support.reply` or `verification.approved`.
  final String? type;
  final String? resourceType;
  final String? resourceId;
  final String? title;
  final String? body;

  bool get isVerification => type?.startsWith('verification.') ?? false;
  bool get isSupportReply => type == 'support.reply';
  bool get isChat => type == 'chat.message';

  /// About a booking (a request, a quote, payment, the work, a cancellation or a chat message): `resourceId` is the booking.
  bool get isBooking => resourceType == 'booking' && resourceId != null;
}

/// The Firebase Cloud Messaging side of push, behind an interface so registration logic can be tested without Firebase.
abstract class PushGateway {
  /// Asks the person for notification permission (a no-op prompt on platforms that do not need one). True when notifications may be shown.
  Future<bool> requestPermission();

  /// This installation's FCM token, or null when unavailable (for example iOS without a configured APNs key).
  Future<String?> getToken();

  /// Fires when FCM rotates the token.
  Stream<String> get onTokenRefresh;

  /// A push that arrived while the app is open (FCM shows nothing itself then).
  Stream<PushEvent> get onForeground;

  /// The person tapped a push shown by the system while the app was in the background.
  Stream<PushEvent> get onOpened;

  /// The push whose tap started the app from closed, if any (read once).
  Future<PushEvent?> initialOpened();

  /// Drops the current token so the next one is new (so a previous user's token cannot linger on the device).
  Future<void> deleteToken();
}

class FirebasePushGateway implements PushGateway {
  FirebasePushGateway([FirebaseMessaging? messaging]) : _messaging = messaging ?? FirebaseMessaging.instance;

  final FirebaseMessaging _messaging;

  @override
  Future<bool> requestPermission() async {
    final settings = await _messaging.requestPermission();
    return settings.authorizationStatus == AuthorizationStatus.authorized || settings.authorizationStatus == AuthorizationStatus.provisional;
  }

  static PushEvent _event(RemoteMessage m) => PushEvent.fromData(m.data, title: m.notification?.title, body: m.notification?.body);

  @override
  Stream<PushEvent> get onForeground => FirebaseMessaging.onMessage.map(_event);

  @override
  Stream<PushEvent> get onOpened => FirebaseMessaging.onMessageOpenedApp.map(_event);

  @override
  Future<PushEvent?> initialOpened() async {
    final m = await _messaging.getInitialMessage();
    return m == null ? null : _event(m);
  }

  // firebase_messaging 17 deprecates the token calls in favour of installation-ID registration (register / onRegistered). The backend and its
  // FCM adapter send to registration TOKENS, so these calls stay until the backend supports installation IDs (a deliberate, separate change).
  @override
  // ignore: deprecated_member_use
  Future<String?> getToken() => _messaging.getToken();

  @override
  // ignore: deprecated_member_use
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  @override
  // ignore: deprecated_member_use
  Future<void> deleteToken() => _messaging.deleteToken();
}

/// Registers this device's FCM token with the backend while someone is signed in, keeps it fresh, and revokes it on sign-out.
///
/// The backend binds the token to the signed-in account (a user id is never sent), encrypts it, and moves it if another account later
/// registers the same physical token. A refreshed token is registered first and the previous registration revoked after, so there is never
/// a gap. The token itself is never logged or stored by the app (only the backend's device id is kept, in secure storage).
class PushService {
  PushService({
    required this.api,
    required this.gateway,
    required this.auth,
    required this.store,
    String Function()? platform,
    this.cleanupLimit = const Duration(seconds: 5),
  }) : _platform = platform ?? _defaultPlatform;

  final HsApi api;
  final PushGateway gateway;
  final AuthController auth;
  final SessionStore store;
  final String Function() _platform;

  /// Longest any single cleanup step may take. Cleanup shares a queue with registration, so a hung network call must not wedge it.
  final Duration cleanupLimit;

  StreamSubscription<String>? _refreshSub;
  StreamSubscription<PushEvent>? _foregroundSub;
  StreamSubscription<PushEvent>? _openedSub;
  final StreamController<PushEvent> _foreground = StreamController<PushEvent>.broadcast();

  /// Pushes that arrive while the app is open and someone is signed in. Show them in the app and refresh what they are about.
  Stream<PushEvent> get foreground => _foreground.stream;

  // Single-subscription on purpose: a tap that started the app is kept until the app is ready to listen.
  final StreamController<PushEvent> _opened = StreamController<PushEvent>();

  /// Pushes the person tapped (also the one that started the app). Open the screen they are about.
  Stream<PushEvent> get opened => _opened.stream;
  final Set<String> _seen = {};

  void _deliver(PushEvent e, StreamController<PushEvent> to) {
    // the backend may send the same push twice (at-least-once); the second is ignored
    final id = e.notificationId;
    if (id != null && !_seen.add('${identical(to, _opened)}:$id')) return;
    if (!to.isClosed) to.add(e);
  }

  Future<void> _queue = Future<void>.value();
  bool _started = false;

  /// Whether the person allowed notifications on the last start.
  bool permissionGranted = false;

  static String _defaultPlatform() => defaultTargetPlatform == TargetPlatform.iOS ? 'IOS' : 'ANDROID';

  /// Call after sign-in or session restore. Safe to call repeatedly.
  Future<void> start() => _serial(() async {
    if (_started) return;
    permissionGranted = await gateway.requestPermission();
    if (!permissionGranted) return; // nothing could be shown; register when the person allows it and the app starts again
    final token = await gateway.getToken();
    if (token == null || token.isEmpty) return;
    _started = true;
    await _register(token);
    _refreshSub = gateway.onTokenRefresh.listen((next) => unawaited(_serial(() => _register(next)).catchError((Object _) {})));
    _foregroundSub = gateway.onForeground.listen((e) => _deliver(e, _foreground));
    _openedSub = gateway.onOpened.listen((e) => _deliver(e, _opened));
    final started = await gateway.initialOpened();
    if (started != null) _deliver(started, _opened);
  });

  /// Call while still signed in (before the session ends): revokes this device's registration.
  Future<void> stop() => _serial(() async {
    unawaited(_refreshSub?.cancel()); // nothing to wait for; awaiting it can stall under fake-async test zones
    _refreshSub = null;
    unawaited(_foregroundSub?.cancel());
    unawaited(_openedSub?.cancel());
    _foregroundSub = null;
    _openedSub = null;
    _seen.clear();
    final wasStarted = _started;
    _started = false;
    final id = await store.readDeviceId();
    if (id != null) {
      try {
        await auth.authorized((t) => api.revokeDevice(accessToken: t, deviceId: id)).timeout(cleanupLimit);
      } catch (_) {} // already gone, offline, or the session ended: the backend also drops it when the token proves dead
      await store.clearDeviceId();
    }
    if (wasStarted) await _dropFcmToken();
  });

  /// Cleanup when the session ended without a normal sign-out (refused refresh, expired stored session). The server session is gone, so the
  /// registration usually cannot be revoked with authority; the revoke is attempted only if a still-valid [accessToken] is at hand.
  /// Either way this device's FCM token is deleted, so the backend's next send to the old registration is answered "unregistered" and it
  /// revokes that row itself (the existing invalid-token handling). Never touches another account: it runs in the same queue as [start].
  Future<void> abandon(String? accessToken) => _serial(() async {
    unawaited(_refreshSub?.cancel()); // nothing to wait for; awaiting it can stall under fake-async test zones
    _refreshSub = null;
    unawaited(_foregroundSub?.cancel());
    unawaited(_openedSub?.cancel());
    _foregroundSub = null;
    _openedSub = null;
    _seen.clear();
    final wasStarted = _started;
    _started = false;
    final id = await store.readDeviceId();
    if (id != null && accessToken != null) {
      try {
        await api.revokeDevice(accessToken: accessToken, deviceId: id).timeout(cleanupLimit);
      } catch (_) {}
    }
    await store.clearDeviceId();
    if (wasStarted || id != null) await _dropFcmToken();
  });

  Future<void> _dropFcmToken() async {
    try {
      await gateway.deleteToken().timeout(cleanupLimit);
    } catch (_) {}
  }

  Future<void> _register(String token) async {
    final newId = await auth.authorized((t) => api.registerDevice(accessToken: t, platform: _platform(), token: token));
    final oldId = await store.readDeviceId();
    await store.writeDeviceId(newId);
    if (oldId != null && oldId != newId) {
      try {
        await auth.authorized((t) => api.revokeDevice(accessToken: t, deviceId: oldId));
      } catch (_) {}
    }
  }

  /// Registrations and revocations run one at a time, in order.
  Future<void> _serial(Future<void> Function() job) {
    final next = _queue.then((_) => job());
    _queue = next.catchError((Object _) {});
    return next;
  }
}
