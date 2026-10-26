import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'errors.dart';
import 'models.dart';
import 'phone_auth_gateway.dart';
import 'storage.dart';

enum AuthStatus {
  /// Not yet known: [AuthController.restore] has not finished.
  unknown,
  signedOut,
  sendingCode,

  /// The SMS was sent; waiting for the person to type the code.
  codeSent,
  verifying,
  signedIn,
}

final _e164 = RegExp(r'^\+[1-9]\d{7,14}$');
final _sixDigits = RegExp(r'^\d{6}$');

/// Phone sign-in and the session that follows it.
///
/// Flow: [sendCode] (Firebase sends the SMS) -> [submitCode] (Firebase confirms it and returns an ID token) -> the token is exchanged with
/// the backend for the usual session (short-lived access token, single-use rotating refresh token). The phone number the backend trusts is
/// the one inside the Firebase token; this class never sends a phone number, user id or role to the backend.
///
/// Refresh tokens are single use and the backend revokes the whole session if one is used twice, so renewals are serialized: any number of
/// concurrent callers share ONE refresh request, and the new refresh token is stored before anything else happens.
class AuthController extends ChangeNotifier {
  AuthController({
    required this.api,
    required this.store,
    required this.phone,
    required this.kind,
    this.resendCooldown = const Duration(seconds: 60),
    this.refreshMargin = const Duration(seconds: 60),
    this.cleanupTimeout = const Duration(seconds: 5),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now {
    _autoSub = phone.autoVerifiedTokens.listen((token) {
      if (_status == AuthStatus.codeSent) unawaited(_exchange(token));
    });
  }

  final HsApi api;
  final SessionStore store;
  final PhoneAuthGateway phone;
  final AppKind kind;
  final Duration resendCooldown;
  final Duration refreshMargin;

  /// Longest sign-out waits for the network (push revocation, server logout). Local sign-out always completes.
  final Duration cleanupTimeout;
  final DateTime Function() _clock;

  /// Called after a session is established (sign-in or restore). Failures are ignored: sign-in must not fail because push setup did.
  Future<void> Function()? onSignedIn;

  /// Called while the session is still valid, just before it ends. Failures are ignored.
  Future<void> Function()? onBeforeSignOut;

  /// Called when the session ended without a normal sign-out (refused refresh, expired stored session), with a still-valid access token if
  /// there is one. Cleanup only: it cannot keep the session, and it is cut off after [cleanupTimeout].
  Future<void> Function(String? accessToken)? onSessionLost;

  StreamSubscription<String>? _autoSub;
  Future<void> _cleanup = Future<void>.value();
  AuthStatus _status = AuthStatus.unknown;
  AuthIssue? _issue;
  Session? _session;
  String? _verificationId;
  int? _resendToken;
  String? _phoneE164;
  DateTime? _resendAvailableAt;
  Future<Session>? _refreshing;

  AuthStatus get status => _status;

  /// Completes when the push cleanup of the last forced sign-out has finished or been cut off. Forced cleanup runs in the background (it can
  /// be triggered from inside a push job, so waiting for it there would deadlock); tests and [restore] wait on this.
  Future<void> get pendingCleanup => _cleanup;

  /// The reason for the last failure, or null. Cleared by the next action.
  AuthIssue? get issue => _issue;
  Session? get session => _session;
  AuthUser? get user => _session?.user;
  bool get isSignedIn => _status == AuthStatus.signedIn && _session != null;

  /// The number the code was sent to (E.164), while a code is pending.
  String? get pendingPhone => _phoneE164;

  /// When a new code may be requested.
  DateTime? get resendAvailableAt => _resendAvailableAt;
  bool get canResend => _resendAvailableAt == null || !_clock().isBefore(_resendAvailableAt!);

  // ------------------------------------------------------------------ restore

  /// On app start: continue the saved session, if any. A session the server no longer accepts is discarded; being offline keeps it.
  Future<void> restore() async {
    final stored = await store.load();
    if (stored == null || !stored.refreshExpiresAt.isAfter(_clock())) {
      _set(AuthStatus.signedOut);
      if (stored != null) {
        await _discardSession(forced: true);
        await _cleanup;
      }
      return;
    }
    _session = stored;
    try {
      await _refresh();
      _set(AuthStatus.signedIn);
      await _announceSignedIn();
    } on ApiException catch (e) {
      if (e.isNetwork || e.status >= 500) {
        _set(AuthStatus.signedIn, issue: AuthIssue.network); // keep the session; the next call refreshes it
        return;
      }
      await _discardSession(forced: true);
      await _cleanup;
    }
  }

  // ------------------------------------------------------------------ sign in

  /// Asks Firebase to send the SMS code. Returns true when a code is pending or the number was verified instantly and the person is
  /// already signed in. On false, [issue] says why.
  Future<bool> sendCode(String phoneE164, {String? languageCode}) async {
    if (!_e164.hasMatch(phoneE164)) return _fail(AuthIssue.invalidPhone, AuthStatus.signedOut);
    _phoneE164 = phoneE164;
    _set(AuthStatus.sendingCode);
    return _requestCode(phoneE164, null, languageCode);
  }

  /// Sends the code again (only after the cooldown).
  Future<bool> resendCode({String? languageCode}) async {
    final number = _phoneE164;
    if (number == null) return _fail(AuthIssue.generic, AuthStatus.signedOut);
    if (!canResend) return false;
    _set(AuthStatus.sendingCode);
    return _requestCode(number, _resendToken, languageCode);
  }

  Future<bool> _requestCode(String number, int? resendToken, String? languageCode) async {
    try {
      final result = await phone.sendCode(phoneE164: number, resendToken: resendToken, languageCode: languageCode);
      switch (result) {
        case CodeSent():
          _verificationId = result.verificationId;
          _resendToken = result.resendToken;
          _resendAvailableAt = _clock().add(resendCooldown);
          _set(AuthStatus.codeSent);
          return true;
        case AutoVerified():
          return _exchange(result.idToken);
      }
    } on PhoneAuthFailure catch (e) {
      return _fail(e.issue, resendToken == null ? AuthStatus.signedOut : AuthStatus.codeSent);
    } catch (_) {
      return _fail(AuthIssue.generic, resendToken == null ? AuthStatus.signedOut : AuthStatus.codeSent);
    }
  }

  /// Confirms the 6-digit code and signs in. Returns true when signed in; on false, [issue] says why and a wrong code can be retried.
  Future<bool> submitCode(String smsCode) async {
    final id = _verificationId;
    if (_status != AuthStatus.codeSent || id == null) return false;
    if (!_sixDigits.hasMatch(smsCode)) return _fail(AuthIssue.invalidCode, AuthStatus.codeSent);
    _set(AuthStatus.verifying);
    try {
      final idToken = await phone.confirmCode(verificationId: id, smsCode: smsCode);
      return _exchange(idToken);
    } on PhoneAuthFailure catch (e) {
      return _fail(e.issue, AuthStatus.codeSent);
    } catch (_) {
      return _fail(AuthIssue.generic, AuthStatus.codeSent);
    }
  }

  /// Trades the Firebase ID token for the backend session.
  Future<bool> _exchange(String idToken) async {
    _set(AuthStatus.verifying);
    try {
      final session = await api.signInWithFirebase(idToken: idToken, app: kind);
      _session = session;
      await store.save(session);
      _verificationId = null;
      _resendToken = null;
      _phoneE164 = null;
      _resendAvailableAt = null;
      unawaited(phone.signOut().catchError((Object _) {})); // the backend session is what counts
      _set(AuthStatus.signedIn);
      await _announceSignedIn();
      return true;
    } on ApiException catch (e) {
      // A network or server hiccup leaves the typed code usable; anything else needs a new code or ends the attempt.
      final retryable = e.isNetwork || e.status >= 500;
      return _fail(e.issue, retryable ? AuthStatus.codeSent : AuthStatus.signedOut);
    }
  }

  /// Back to the phone-number screen (for "change number").
  void backToPhone() {
    _verificationId = null;
    _resendToken = null;
    _resendAvailableAt = null;
    if (_status != AuthStatus.signedIn) _set(AuthStatus.signedOut);
  }

  // ------------------------------------------------------------------ session

  /// A valid access token, renewing it first when it is about to expire. Null when signed out.
  Future<String?> accessToken() async {
    final session = _session;
    if (session == null) return null;
    if (session.accessToken.isNotEmpty && session.accessExpiresAt.isAfter(_clock().add(refreshMargin))) return session.accessToken;
    return (await _refreshOrDiscard()).accessToken; // a refused refresh ends the session here too
  }

  /// Saves the signed-in person's name on the server and in the stored session, so every screen shows it at once.
  Future<void> updateName(String fullName) async {
    final saved = await authorized((t) => api.updateCustomerName(t, fullName));
    final current = _session;
    if (current == null) return;
    final next = current.withUser(current.user.withName(saved ?? fullName));
    _session = next;
    await store.save(next);
    notifyListeners();
  }

  /// Runs [call] with an access token. A 401 renews the session once and retries; if renewal fails the person is signed out locally.
  Future<T> authorized<T>(Future<T> Function(String accessToken) call) async {
    final token = await accessToken();
    if (token == null) throw const ApiException(status: 401, code: 'NO_SESSION');
    try {
      return await call(token);
    } on ApiException catch (e) {
      if (!e.isUnauthorized) rethrow;
      final fresh = await _refreshOrDiscard();
      return call(fresh.accessToken);
    }
  }

  Future<Session> _refreshOrDiscard() async {
    try {
      return await _refresh();
    } on ApiException catch (e) {
      if (e.isUnauthorized || e.status == 403) await _discardSession(forced: true);
      rethrow;
    }
  }

  /// Single flight: concurrent callers await the same request, so a single-use refresh token is never used twice.
  Future<Session> _refresh() => _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);

  Future<Session> _doRefresh() async {
    final current = _session;
    if (current == null) throw const ApiException(status: 401, code: 'NO_SESSION');
    final next = await api.refresh(current.refreshToken);
    _session = next;
    await store.save(next); // the old refresh token is dead now; keep the new one before anything else
    notifyListeners();
    return next;
  }

  /// Ends the session: push registration first (needs the session), then the server session, then local data. Always ends signed out.
  /// Records the worker verification status the server reported, so the stored user (and start-up routing) matches it.
  Future<void> applyWorkerStatus(String? status) async {
    final session = _session;
    if (session == null || session.user.workerVerificationStatus == status) return;
    final next = session.withUser(session.user.withWorkerStatus(status));
    _session = next;
    try {
      await store.save(next);
    } catch (_) {}
    notifyListeners();
  }

  Future<void> signOut() async {
    final session = _session;
    // Push revocation needs the live session, so it comes first; both steps are cut off so sign-out never hangs on the network.
    await _bounded(onBeforeSignOut);
    if (session != null) {
      await _bounded(() => api.logout(session.refreshToken)); // the server answers 204 for anything; offline just leaves it to expire
    }
    await _discardSession();
  }

  Future<void> _bounded(Future<void> Function()? job) async {
    if (job == null) return;
    try {
      await job().timeout(cleanupTimeout);
    } catch (_) {}
  }

  /// Forgets the session locally. The local state is final before any network cleanup starts. [forced] means the server session is already
  /// gone or unusable, so only [onSessionLost] cleanup (bounded) follows.
  Future<void> _discardSession({bool forced = false}) async {
    final lost = _session;
    _session = null;
    _refreshing = null;
    _verificationId = null;
    _resendToken = null;
    _phoneE164 = null;
    _resendAvailableAt = null;
    try {
      await store.clearSession();
    } catch (_) {}
    unawaited(phone.signOut().catchError((Object _) {}));
    _set(AuthStatus.signedOut);
    if (forced) {
      final usable = lost != null && lost.accessToken.isNotEmpty && lost.accessExpiresAt.isAfter(_clock()) ? lost.accessToken : null;
      // Not awaited: this can run inside a push job, and the cleanup is queued behind it. The cleanup clears the device id itself, in the
      // same queue as the next account's registration, so it can never wipe an id that account has just stored.
      _cleanup = _bounded(() async => onSessionLost?.call(usable));
    } else {
      try {
        await store.clearDeviceId();
      } catch (_) {}
    }
  }

  Future<void> _announceSignedIn() async {
    try {
      await onSignedIn?.call();
    } catch (_) {}
  }

  // ------------------------------------------------------------------ state

  bool _fail(AuthIssue issue, AuthStatus next) {
    _set(next, issue: issue);
    return false;
  }

  void _set(AuthStatus next, {AuthIssue? issue}) {
    _status = next;
    _issue = issue;
    notifyListeners();
  }

  @override
  void dispose() {
    _autoSub?.cancel();
    super.dispose();
  }
}
