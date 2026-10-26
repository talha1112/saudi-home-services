import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'errors.dart';
import 'worker_models.dart';

/// Why a worker-onboarding step did not work, in terms an app can turn into a message. Never carries tokens, file bytes or upload addresses.
enum OnboardingIssue {
  network,

  /// The session ended (the person is signed out); the app returns to sign-in.
  sessionExpired,

  /// The backend has no document storage configured. Nothing was uploaded or recorded.
  storageUnavailable,
  validation,

  /// The server refuses the change in the current state (suspended account, documents locked during review, application not editable).
  notAllowed,

  /// Submission refused: required information is still missing (see [OnboardingFailure.missing]).
  incomplete,

  /// The server does not accept a submission in the application's current state; the screen reloads.
  invalidState,
  fileTooLarge,
  unsupportedFile,

  /// The server inspected the file and refused it (content does not match, or the malware scan flagged it).
  fileRejected,

  /// Sending the file to storage failed (address expired, storage refused, connection lost). Nothing is left registered.
  uploadFailed,
  documentLimit,
  tooManyRequests,
  unavailable,
  generic,
}

class OnboardingFailure {
  const OnboardingFailure(this.issue, {this.missing = const [], this.fieldMessages = const []});

  final OnboardingIssue issue;

  /// With [OnboardingIssue.incomplete]: FULL_NAME, YEARS_OF_EXPERIENCE, SERVICES, SERVICE_AREAS, AVAILABILITY, IDENTITY_DOCUMENT.
  final List<String> missing;

  /// With [OnboardingIssue.validation]: the server's own field messages (English).
  final List<String> fieldMessages;

  @override
  String toString() => 'OnboardingFailure($issue)';
}

/// Largest document the backend accepts.
const int kMaxDocumentBytes = 10 * 1024 * 1024;

const Map<String, String> _mimeByExtension = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'pdf': 'application/pdf'};

/// The worker's application: profile, services, cities, schedule, documents and the server-side verification state.
///
/// The server is the only source of truth: every value shown comes from a response, a save is shown only after the server accepted it, and
/// an unavailable provider (no document storage) is reported as such: nothing is faked. Refreshes are throttled so entering screens and
/// returning to the app do not hammer the API.
class WorkerOnboardingController extends ChangeNotifier {
  WorkerOnboardingController({
    required this.api,
    required this.auth,
    this.minRefreshInterval = const Duration(seconds: 20),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final HsApi api;
  final AuthController auth;
  final Duration minRefreshInterval;
  final DateTime Function() _clock;

  WorkerOnboarding? _onboarding;
  Catalog? _catalog;
  OnboardingFailure? _failure;
  bool _busy = false;
  bool _loadedOnce = false;
  DateTime? _lastRefresh;
  Future<bool>? _refreshing;
  Future<bool>? _catalogLoading;

  WorkerOnboarding? get onboarding => _onboarding;
  Catalog? get catalog => _catalog;

  /// The last failure, cleared by the next successful call.
  OnboardingFailure? get failure => _failure;

  /// A save, upload or submission is running.
  bool get busy => _busy;

  /// The first load has finished (successfully or not).
  bool get loadedOnce => _loadedOnce;
  VerificationInfo? get verification => _onboarding?.verification;

  // ------------------------------------------------------------------ reads

  /// Loads the application from the server. Within [minRefreshInterval] of the last successful load this does nothing unless [force]
  /// (after a save or submission the server's answer has already replaced the state). Concurrent calls share one request.
  Future<bool> refresh({bool force = false}) {
    final last = _lastRefresh;
    if (!force && _onboarding != null && last != null && _clock().difference(last) < minRefreshInterval) return Future.value(true);
    return _refreshing ??= _load().whenComplete(() => _refreshing = null);
  }

  Future<bool> _load() async {
    try {
      final data = await auth.authorized((t) => api.workerOnboarding(t));
      _apply(data);
      _lastRefresh = _clock();
      _failure = null;
      return true;
    } on ApiException catch (e) {
      _failure = _map(e);
      return false;
    } finally {
      _loadedOnce = true;
      notifyListeners();
    }
  }

  /// Service categories and cities for the forms (public data, cached once loaded).
  Future<bool> loadCatalog() {
    if (_catalog != null) return Future.value(true);
    return _catalogLoading ??= _loadCatalog().whenComplete(() => _catalogLoading = null);
  }

  Future<bool> _loadCatalog() async {
    try {
      _catalog = await api.catalog();
      return true;
    } on ApiException catch (e) {
      _failure = _map(e);
      return false;
    } finally {
      notifyListeners();
    }
  }

  // ------------------------------------------------------------------ writes (each returns true only when the server accepted it)

  Future<bool> saveProfile({String? fullName, String? fullNameAr, String? bio, int? yearsOfExperience}) => _write(
    () => auth.authorized(
      (t) => api.updateWorkerProfile(t, fullName: fullName, fullNameAr: fullNameAr, bio: bio, yearsOfExperience: yearsOfExperience),
    ),
  );

  Future<bool> saveServices(Iterable<String> serviceIds) => _write(() => auth.authorized((t) => api.setWorkerServices(t, serviceIds.toList())));

  Future<bool> saveAreas(Iterable<String> cityIds) => _write(() => auth.authorized((t) => api.setWorkerAreas(t, cityIds.toList())));

  Future<bool> saveAvailability(List<AvailabilityWindow> windows) => _write(() => auth.authorized((t) => api.setWorkerAvailability(t, windows)));

  /// Uploads one document through the backend's signed-upload protocol: register -> PUT bytes -> confirm. The file is never counted until the
  /// server confirmed it, and what the server says about scanning is kept as is (an unscanned file is NOT presented as safe).
  Future<bool> uploadDocument({required DocumentKind kind, required String fileName, required Uint8List bytes, String? expiresOn}) async {
    final mime = _mimeByExtension[_extension(fileName)];
    if (mime == null) return _fail(const OnboardingFailure(OnboardingIssue.unsupportedFile));
    if (bytes.isEmpty || bytes.length > kMaxDocumentBytes) return _fail(const OnboardingFailure(OnboardingIssue.fileTooLarge));
    return _guard(() async {
      final ticket = await auth.authorized(
        (t) => api.registerWorkerDocument(t, kind: kind, fileName: fileName, mimeType: mime, sizeBytes: bytes.length, expiresOn: expiresOn),
      );
      try {
        await api.uploadToSignedUrl(ticket, bytes);
        await auth.authorized((t) => api.confirmWorkerDocument(t, ticket.document.id));
      } catch (_) {
        await _discardPending(ticket.document.id); // a half-finished upload must not linger and count toward the limit
        rethrow;
      }
      await _reloadQuietly();
    });
  }

  Future<bool> deleteDocument(String documentId) => _guard(() async {
    await auth.authorized((t) => api.deleteWorkerDocument(t, documentId));
    await _reloadQuietly();
  });

  /// Submits (or resubmits) the application. The result is the server's: on success the new state is already in [verification].
  Future<bool> submit() => _guard(() async {
    final info = await auth.authorized((t) => api.submitWorkerVerification(t));
    final current = _onboarding;
    if (current != null) {
      _onboarding = WorkerOnboarding(
        profile: current.profile,
        serviceIds: current.serviceIds,
        cityIds: current.cityIds,
        availability: current.availability,
        documents: current.documents,
        verification: info,
      );
    }
    await auth.applyWorkerStatus(info.rawStatus);
    await _reloadQuietly();
  });

  // ------------------------------------------------------------------ internals

  Future<bool> _write(Future<WorkerOnboarding> Function() call) => _guard(() async {
    _apply(await call());
  });

  Future<bool> _guard(Future<void> Function() job) async {
    if (_busy) return false;
    _busy = true;
    _failure = null;
    notifyListeners();
    try {
      await job();
      return true;
    } on ApiException catch (e) {
      _failure = _map(e);
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  bool _fail(OnboardingFailure failure) {
    _failure = failure;
    notifyListeners();
    return false;
  }

  /// After a change that already succeeded: pull the server's view, but never report the change as failed because this follow-up failed.
  Future<void> _reloadQuietly() async {
    try {
      final data = await auth.authorized((t) => api.workerOnboarding(t));
      _apply(data);
      _lastRefresh = _clock();
    } on ApiException {
      _lastRefresh = null; // the next screen entry loads again
    }
  }

  Future<void> _discardPending(String id) async {
    try {
      await auth.authorized((t) => api.deleteWorkerDocument(t, id)).timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  void _apply(WorkerOnboarding data) {
    _onboarding = data;
    unawaited(auth.applyWorkerStatus(data.verification.rawStatus)); // keeps the stored user (and so start-up routing) in step with the server
  }

  String _extension(String name) {
    final dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  }

  OnboardingFailure _map(ApiException e) {
    if (e.isNetwork) return const OnboardingFailure(OnboardingIssue.network);
    switch (e.code) {
      case 'NO_SESSION':
      case 'UNAUTHORIZED':
      case 'REFRESH_TOKEN_INVALID':
      case 'REFRESH_TOKEN_REUSED':
      case 'REFRESH_TOKEN_REVOKED':
      case 'REFRESH_TOKEN_EXPIRED':
        return const OnboardingFailure(OnboardingIssue.sessionExpired);
      case 'DOCUMENT_STORAGE_NOT_CONFIGURED':
        return const OnboardingFailure(OnboardingIssue.storageUnavailable);
      case 'VERIFICATION_INCOMPLETE':
        final missing = e.details?['missing'];
        return OnboardingFailure(OnboardingIssue.incomplete, missing: missing is List ? [for (final m in missing) '$m'] : const []);
      case 'INVALID_STATE':
        return const OnboardingFailure(OnboardingIssue.invalidState);
      case 'FILE_TOO_LARGE':
        return const OnboardingFailure(OnboardingIssue.fileTooLarge);
      case 'FILE_CONTENT_INVALID':
      case 'FILE_REJECTED_BY_SCAN':
        return const OnboardingFailure(OnboardingIssue.fileRejected);
      case 'UPLOAD_NOT_FOUND':
      case 'UPLOAD_FAILED':
      case 'UPLOAD_URL_REJECTED':
        return const OnboardingFailure(OnboardingIssue.uploadFailed);
      case 'DOCUMENT_LIMIT':
        return const OnboardingFailure(OnboardingIssue.documentLimit);
      case 'DOCUMENTS_LOCKED':
      case 'WORKER_SUSPENDED':
        return const OnboardingFailure(OnboardingIssue.notAllowed);
    }
    if (e.isUnauthorized) return const OnboardingFailure(OnboardingIssue.sessionExpired);
    if (e.status == 400 || e.status == 422) return OnboardingFailure(OnboardingIssue.validation, fieldMessages: e.fieldMessages);
    if (e.status == 403) return const OnboardingFailure(OnboardingIssue.notAllowed);
    if (e.status == 429) return const OnboardingFailure(OnboardingIssue.tooManyRequests);
    if (e.status == 503) return const OnboardingFailure(OnboardingIssue.unavailable);
    return const OnboardingFailure(OnboardingIssue.generic);
  }
}
