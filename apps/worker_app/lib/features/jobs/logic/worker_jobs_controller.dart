import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

enum LoadStatus { idle, loading, ready, failed }

/// One list loaded from the backend: idle -> loading -> ready / failed. A refresh that fails keeps what was already shown.
class _Feed<T> {
  _Feed(this._fetch, this._changed);

  final Future<List<T>> Function() _fetch;
  final VoidCallback _changed;

  LoadStatus status = LoadStatus.idle;
  List<T> items = const [];
  ApiException? error;
  Future<void>? _running;

  Future<void> load() =>
      _running ??= _run().whenComplete(() => _running = null);

  Future<void> _run() async {
    status = items.isEmpty ? LoadStatus.loading : status;
    error = null;
    _changed();
    try {
      items = await _fetch();
      status = LoadStatus.ready;
    } on ApiException catch (e) {
      error = e;
      status = items.isEmpty ? LoadStatus.failed : LoadStatus.ready;
    }
    _changed();
  }

  void clear() {
    status = LoadStatus.idle;
    items = const [];
    error = null;
  }
}

/// What a start/complete attempt came to.
enum JobActionOutcome {
  done,
  notFound,
  wrongState,
  notSignedIn,
  network,
  unavailable,
  failed,
}

/// The signed-in worker's requests and jobs, from the backend:
///  * `GET /workers/me/requests`: open requests for their services and cities (city and district only);
///  * `GET /workers/me/bookings`: bookings assigned to them after the customer accepted their quote.
///
/// A worker does not "accept" a request: they send a quote, the customer chooses one, and only then is the booking assigned. This
/// controller therefore only reads; sending a quote is [QuoteSubmitter]'s job, and starting or finishing an assigned job is done here.
class WorkerJobsController extends ChangeNotifier {
  WorkerJobsController({required this.api, required this.auth}) {
    _requests = _Feed(
      () async => (await auth.authorized(
        (t) => api.workerRequests(t, limit: 50),
      )).items,
      notifyListeners,
    );
    _jobs = _Feed(
      () async =>
          (await auth.authorized((t) => api.workerJobs(t, limit: 100))).items,
      notifyListeners,
    );
  }

  final HsApi api;
  final AuthController auth;

  late final _Feed<WorkerRequest> _requests;
  late final _Feed<WorkerJob> _jobs;
  final Map<String, Future<JobActionOutcome>> _acting = {};

  LoadStatus get requestsStatus => _requests.status;
  ApiException? get requestsError => _requests.error;
  List<WorkerRequest> get requests => _requests.items;

  LoadStatus get jobsStatus => _jobs.status;
  ApiException? get jobsError => _jobs.error;
  List<WorkerJob> get jobs => _jobs.items;

  /// Open requests this worker has not quoted on yet.
  List<WorkerRequest> get newRequests => [
    for (final r in requests)
      if (r.myQuote == null) r,
  ];

  /// Open requests this worker has quoted on (the customer has not chosen yet).
  List<WorkerRequest> get quotedRequests => [
    for (final r in requests)
      if (r.myQuote != null) r,
  ];

  /// Assigned jobs in any of [statuses].
  List<WorkerJob> jobsIn(Set<String> statuses) => [
    for (final j in jobs)
      if (statuses.contains(j.status)) j,
  ];

  Future<void> loadRequests() => _requests.load();
  Future<void> loadJobs() => _jobs.load();
  Future<void> refresh() => Future.wait([loadRequests(), loadJobs()]);

  WorkerJob? jobById(String id) {
    for (final j in jobs) {
      if (j.id == id) return j;
    }
    return null;
  }

  /// A fresh copy of one request (with its description and photo count). Not stored in the list.
  Future<WorkerRequest> requestDetail(String id) =>
      auth.authorized((t) => api.workerRequest(t, id));

  /// Reloads one assigned job and puts it in the list. Throws the backend's [ApiException] (404 for a booking that is not this worker's).
  Future<WorkerJob> reloadJob(String id) async {
    final job = await auth.authorized((t) => api.workerJob(t, id));
    _storeJob(job);
    return job;
  }

  /// The request now carries the quote the backend returned (so the lists change without another round trip).
  void recordQuote(String requestId, WorkerQuote quote) {
    final i = requests.indexWhere((r) => r.id == requestId);
    if (i < 0) return;
    final r = requests[i];
    final updated = WorkerRequest(
      id: r.id,
      reference: r.reference,
      status: r.status,
      service: r.service,
      location: r.location,
      isUrgent: r.isUrgent,
      preferredStartAt: r.preferredStartAt,
      preferredEndAt: r.preferredEndAt,
      expiresAt: r.expiresAt,
      myQuote: quote,
      createdAt: r.createdAt,
      problemDescription: r.problemDescription,
      photoCount: r.photoCount,
    );
    _requests.items = [...requests]..[i] = updated;
    notifyListeners();
  }

  /// CONFIRMED -> IN_PROGRESS. Taps while it is running share one request.
  Future<JobActionOutcome> startJob(String id) =>
      _act(id, 'start', (t) => api.startWorkerJob(t, id));

  /// The worker confirms receiving the cash for a CASH booking (once the work has started). Taps while it runs share one request.
  Future<JobActionOutcome> confirmCash(String id) =>
      _act(id, 'cash', (t) => api.confirmCashCollected(t, id));

  /// IN_PROGRESS -> COMPLETED.
  Future<JobActionOutcome> completeJob(String id) =>
      _act(id, 'complete', (t) => api.completeWorkerJob(t, id));

  bool isActing(String id) => _acting.keys.any((k) => k.endsWith(':$id'));

  Future<JobActionOutcome> _act(
    String id,
    String action,
    Future<WorkerJob> Function(String token) call,
  ) {
    final key = '$action:$id';
    final running = _acting[key];
    if (running != null) return running;
    final future = _doAct(id, call).whenComplete(() {
      _acting.remove(key);
      notifyListeners();
    });
    _acting[key] = future;
    notifyListeners();
    return future;
  }

  Future<JobActionOutcome> _doAct(
    String id,
    Future<WorkerJob> Function(String token) call,
  ) async {
    try {
      final job = await auth.authorized(call);
      _storeJob(job);
      return JobActionOutcome.done;
    } on ApiException catch (e) {
      if (e.status == 0) return JobActionOutcome.network;
      if (e.isUnauthorized || e.code == 'NO_SESSION') {
        return JobActionOutcome.notSignedIn;
      }
      if (e.status == 404) return JobActionOutcome.notFound;
      if (e.status == 409) {
        // someone else changed it (the customer cancelled, an administrator acted): show the truth
        unawaited(reloadJob(id).then((_) {}, onError: (_) {}));
        return JobActionOutcome.wrongState;
      }
      if (e.status == 429 || e.status >= 500) {
        return JobActionOutcome.unavailable;
      }
      return JobActionOutcome.failed;
    }
  }

  void _storeJob(WorkerJob job) {
    final i = jobs.indexWhere((j) => j.id == job.id);
    _jobs.items = i < 0 ? [job, ...jobs] : ([...jobs]..[i] = job);
    if (_jobs.status == LoadStatus.idle || _jobs.status == LoadStatus.failed) {
      _jobs.status = LoadStatus.ready;
    }
    notifyListeners();
  }

  /// Forgets everything (on sign-out), so the next worker never sees this one's requests or jobs.
  void clear() {
    _requests.clear();
    _jobs.clear();
    _acting.clear();
    notifyListeners();
  }
}
