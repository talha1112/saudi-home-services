import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

import '../../jobs/logic/worker_jobs_controller.dart';

enum QuoteProblem {
  /// The price is missing or not a positive amount; nothing was sent.
  invalidPrice,

  /// The backend's minimum service charge (in [QuoteFailure.limitHalalas]).
  belowMinimum,

  /// The backend's maximum price (in [QuoteFailure.limitHalalas]).
  aboveMaximum,

  /// The proposed times were refused (message in [QuoteFailure.message]).
  window,

  /// The request is gone, closed, or not one this worker may quote on.
  unavailable,

  /// The request already has the maximum number of quotes.
  full,
  notSignedIn,

  /// The backend refused the content (field messages in [QuoteFailure.fieldMessages]).
  validation,
  network,
  busy,
  other,
}

class QuoteFailure {
  const QuoteFailure(
    this.problem, {
    this.message,
    this.limitHalalas,
    this.fieldMessages = const [],
  });
  final QuoteProblem problem;
  final String? message;
  final int? limitHalalas;
  final List<String> fieldMessages;
}

/// Sends a worker's quote (`POST /workers/me/requests/:bookingId/quote`).
///
/// The backend allows one quote per worker per request (409 QUOTE_EXISTS afterwards), which makes a retry safe: if an earlier attempt
/// reached the server but its answer was lost, the retry gets QUOTE_EXISTS and this class simply fetches the quote that exists. On top of
/// that, taps while a send is running share it, so a double tap makes one request. The server computes VAT, commission and the total; the
/// app sends only the worker's own price.
class QuoteSubmitter extends ChangeNotifier {
  QuoteSubmitter({required this.api, required this.auth, required this.jobs});

  final HsApi api;
  final AuthController auth;
  final WorkerJobsController jobs;

  final Map<String, Future<WorkerQuote?>> _running = {};

  /// Quotes this session has already sent, by request: a second tap on a screen that has not redrawn yet gets the same quote.
  final Map<String, WorkerQuote> _sent = {};
  QuoteFailure? _failure;

  bool get busy => _running.isNotEmpty;
  bool isSending(String requestId) => _running.containsKey(requestId);
  QuoteFailure? get failure => _failure;

  /// Forgets everything (on sign-out).
  void reset() {
    _sent.clear();
    _failure = null;
    notifyListeners();
  }

  void clearFailure() {
    if (_failure == null) return;
    _failure = null;
    notifyListeners();
  }

  /// Returns the worker's quote on the request, or null with [failure] set.
  Future<WorkerQuote?> submit(String requestId, SubmitQuoteRequest request) {
    final running = _running[requestId];
    if (running != null) return running;
    // already sent (the screen has not caught up with a very fast second tap): hand back that quote, send nothing
    final done = _sent[requestId];
    if (done != null && done.isLive) return Future.value(done);
    for (final r in jobs.requests) {
      if (r.id == requestId && r.myQuote != null && r.myQuote!.isLive) {
        return Future.value(r.myQuote);
      }
    }
    final future = _run(requestId, request).whenComplete(() {
      _running.remove(requestId);
      notifyListeners();
    });
    _running[requestId] = future;
    notifyListeners();
    return future;
  }

  Future<WorkerQuote?> _run(
    String requestId,
    SubmitQuoteRequest request,
  ) async {
    _failure = null;
    if (request.priceHalalas <= 0) {
      return _fail(const QuoteFailure(QuoteProblem.invalidPrice));
    }
    try {
      final quote = await auth.authorized(
        (t) => api.submitQuote(t, requestId, request),
      );
      jobs.recordQuote(requestId, quote);
      _sent[requestId] = quote;
      return quote;
    } on ApiException catch (e) {
      if (e.code == 'QUOTE_EXISTS') return _adopt(requestId, e);
      return _fail(_classify(e));
    }
  }

  /// Changes the worker's live quote (`PATCH /workers/me/quotes/:id`); the server prices it again. Returns the quote, or null with [failure] set.
  Future<WorkerQuote?> revise(
    String requestId,
    WorkerQuote quote,
    SubmitQuoteRequest request,
  ) => _change(
    requestId,
    (t) => api.updateWorkerQuote(t, quote.id, request),
    invalid: request.priceHalalas <= 0,
  );

  /// Takes the quote back (`POST /workers/me/quotes/:id/withdraw`). Returns the withdrawn quote, or null with [failure] set.
  Future<WorkerQuote?> withdraw(String requestId, WorkerQuote quote) =>
      _change(requestId, (t) => api.withdrawWorkerQuote(t, quote.id));

  Future<WorkerQuote?> _change(
    String requestId,
    Future<WorkerQuote> Function(String token) call, {
    bool invalid = false,
  }) {
    final running = _running[requestId];
    if (running != null) return running;
    final future =
        (() async {
          _failure = null;
          if (invalid) return _fail(const QuoteFailure(QuoteProblem.invalidPrice));
          try {
            final changed = await auth.authorized(call);
            jobs.recordQuote(requestId, changed);
            _sent[requestId] = changed;
            return changed;
          } on ApiException catch (e) {
            return _fail(_classify(e));
          }
        })().whenComplete(() {
          _running.remove(requestId);
          notifyListeners();
        });
    _running[requestId] = future;
    notifyListeners();
    return future;
  }

  /// The quote is already there (an earlier attempt got through): show it instead of failing.
  Future<WorkerQuote?> _adopt(String requestId, ApiException original) async {
    try {
      final existing = (await jobs.requestDetail(requestId)).myQuote;
      if (existing != null) {
        jobs.recordQuote(requestId, existing);
        _sent[requestId] = existing;
        return existing;
      }
    } on ApiException catch (e) {
      return _fail(_classify(e));
    }
    return _fail(_classify(original));
  }

  WorkerQuote? _fail(QuoteFailure f) {
    _failure = f;
    return null;
  }

  QuoteFailure _classify(ApiException e) {
    if (e.status == 0) return const QuoteFailure(QuoteProblem.network);
    if (e.isUnauthorized || e.code == 'NO_SESSION') {
      return const QuoteFailure(QuoteProblem.notSignedIn);
    }
    switch (e.code) {
      case 'PRICE_BELOW_MINIMUM':
        return QuoteFailure(
          QuoteProblem.belowMinimum,
          limitHalalas: (e.details?['minServiceChargeHalalas'] as num?)
              ?.toInt(),
        );
      case 'PRICE_TOO_HIGH':
        return QuoteFailure(
          QuoteProblem.aboveMaximum,
          limitHalalas: (e.details?['maxHalalas'] as num?)?.toInt(),
        );
      case 'INVALID_PRICE':
        return const QuoteFailure(QuoteProblem.invalidPrice);
      case 'INVALID_PROPOSED_WINDOW':
      case 'INVALID_VALIDITY':
        return QuoteFailure(QuoteProblem.window, message: e.message);
      case 'BOOKING_NOT_OPEN':
      case 'NOT_FOUND':
        return const QuoteFailure(QuoteProblem.unavailable);
      case 'QUOTE_LIMIT_REACHED':
        return const QuoteFailure(QuoteProblem.full);
    }
    if (e.status == 404) return const QuoteFailure(QuoteProblem.unavailable);
    if (e.status == 400) {
      return QuoteFailure(
        QuoteProblem.validation,
        message: e.message,
        fieldMessages: e.fieldMessages,
      );
    }
    if (e.status == 429 || e.status >= 500) {
      return const QuoteFailure(QuoteProblem.busy);
    }
    return const QuoteFailure(QuoteProblem.other);
  }
}
