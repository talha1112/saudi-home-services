import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

enum DetailStatus { loading, ready, failed, gone }

/// What choosing a quote or paying came to.
enum ActionProblem {
  /// The worker changed the quote after the customer saw it (409 QUOTE_CHANGED): the new price is shown instead.
  quoteChanged,

  /// The booking is no longer open, or the quote is gone.
  notAvailable,

  /// No payment provider is set up on the server (503 PAYMENT_PROVIDER_NOT_CONFIGURED).
  paymentsNotConfigured,
  alreadyPaid,
  notPayable,
  deadlinePassed,
  workerUnavailable,

  /// Another payment attempt is already open; the screen shows where it stands.
  paymentInProgress,
  notSignedIn,
  network,
  busy,
  other,
}

class ActionFailure {
  const ActionFailure(this.problem, {this.message});
  final ActionProblem problem;
  final String? message;
}

/// One of the customer's bookings in full: its quotes while it is OPEN, choosing a quote, and paying.
///
/// Nothing here decides a price or marks anything paid. Prices come from the server; accepting sends only the quote id and the version the
/// customer saw; and a booking is paid only when the SERVER says its status is CONFIRMED, never because a checkout page was opened or a
/// payment call returned.
class BookingDetailController extends ChangeNotifier {
  BookingDetailController({
    required this.api,
    required this.auth,
    required this.bookingId,
    Random? random,
  }) : _random = random ?? Random.secure();

  final HsApi api;
  final AuthController auth;
  final String bookingId;
  final Random _random;

  DetailStatus _status = DetailStatus.loading;
  BookingDetail? _detail;
  List<CustomerQuote> _quotes = const [];
  PaymentAttempt? _attempt;
  ActionFailure? _failure;
  ApiException? _error;
  Future<void>? _loading;
  Future<bool>? _accepting;
  Future<PaymentAttempt?>? _paying;
  Future<bool>? _cashing;
  String? _payKey;

  // The customer's review of this booking once it is completed.
  MyReview? _review;
  bool _reviewChecked = false;
  bool _reviewFailed = false;
  Future<bool>? _reviewing;

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  /// A request that finishes after the screen was closed must not touch a disposed notifier.
  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  DetailStatus get status => _status;
  BookingDetail? get detail => _detail;
  List<CustomerQuote> get quotes => _quotes;
  PaymentAttempt? get attempt => _attempt;
  ActionFailure? get failure => _failure;
  ApiException? get error => _error;
  bool get accepting => _accepting != null;
  bool get paying => _paying != null;
  bool get cashing => _cashing != null;

  /// The customer's review of this booking, once it is completed and they have written one.
  MyReview? get review => _review;

  /// True once the server has been asked whether a review exists (a completed booking).
  bool get reviewChecked => _reviewChecked;
  bool get reviewing => _reviewing != null;

  /// The last attempt to send a review failed.
  bool get reviewFailed => _reviewFailed;

  /// True only when the server reports the booking as paid (CONFIRMED or later).
  bool get isPaid =>
      const {'CONFIRMED', 'IN_PROGRESS', 'COMPLETED'}.contains(_detail?.status);

  void clearFailure() {
    if (_failure == null) return;
    _failure = null;
    notifyListeners();
  }

  /// Loads the booking, and its quotes while it is open. A refresh that fails keeps what is already shown.
  Future<void> load() =>
      _loading ??= _load().whenComplete(() => _loading = null);

  Future<void> _load() async {
    _error = null;
    try {
      final detail = await auth.authorized(
        (t) => api.bookingDetail(t, bookingId),
      );
      var quotes = _quotes;
      if (detail.status == 'OPEN') {
        quotes = await auth.authorized((t) => api.bookingQuotes(t, bookingId));
      } else {
        quotes = const [];
      }
      _detail = detail;
      _quotes = quotes;
      _status = DetailStatus.ready;
      if (detail.status == 'COMPLETED' && !_reviewChecked) await _checkReview();
    } on ApiException catch (e) {
      _error = e;
      if (e.status == 404) {
        _status = DetailStatus.gone;
      } else if (_detail == null) {
        _status = DetailStatus.failed;
      }
    }
    notifyListeners();
  }

  Future<void> _checkReview() async {
    try {
      _review = await auth.authorized((t) => api.myReview(t, bookingId));
      _reviewChecked = true;
    } on ApiException {
      // Unknown for now: the review form stays hidden until the next refresh answers.
    }
  }

  /// Sends the customer's review of the worker (once). Taps while it runs share one request. Returns true when it was saved.
  Future<bool> submitReview(int rating, String comment) =>
      _reviewing ??= _submitReview(rating, comment).whenComplete(() {
        _reviewing = null;
        notifyListeners();
      });

  Future<bool> _submitReview(int rating, String comment) async {
    _reviewFailed = false;
    notifyListeners();
    try {
      _review = await auth.authorized(
        (t) => api.submitReview(t, bookingId, rating: rating, comment: comment),
      );
      _reviewChecked = true;
      return true;
    } on ApiException catch (e) {
      // 409 means a review exists already (another phone, a repeat): show it instead of an error.
      if (e.status == 409) {
        _reviewChecked = false;
        await _checkReview();
        return _review != null;
      }
      _reviewFailed = true;
      return false;
    }
  }

  /// Chooses [quote]. Taps while it runs share one request. Returns true when the booking moved to PAYMENT_PENDING.
  Future<bool> accept(CustomerQuote quote) =>
      _accepting ??= _accept(quote).whenComplete(() {
        _accepting = null;
        notifyListeners();
      });

  Future<bool> _accept(CustomerQuote quote) async {
    _failure = null;
    notifyListeners();
    try {
      final detail = await auth.authorized(
        (t) => api.acceptQuote(
          t,
          bookingId,
          quote.id,
          expectedVersion: quote.version,
        ),
      );
      _detail = detail;
      _quotes = const [];
      return true;
    } on ApiException catch (e) {
      _failure = _classify(e);
      // the truth may have changed (a new price, a closed booking): show it
      if (e.status == 409 || e.status == 404) unawaited(load());
      return false;
    }
  }

  /// Pays in cash: the booking is confirmed at once and the customer pays the agreed total to the worker in person. Taps while it runs share
  /// one request, and the server treats a repeat as already done. Returns true when the server reports the booking as confirmed.
  Future<bool> payCash() => _cashing ??= _payCash().whenComplete(() {
    _cashing = null;
    notifyListeners();
  });

  Future<bool> _payCash() async {
    _failure = null;
    notifyListeners();
    try {
      _detail = await auth.authorized((t) => api.payCash(t, bookingId));
      return isPaid;
    } on ApiException catch (e) {
      final failure = _classify(e);
      _failure = failure;
      // the truth may be different from what is on screen (already paid, cancelled, payment deadline): show it
      if (e.status == 409 || e.status == 404) unawaited(load());
      return false;
    }
  }

  /// Starts paying online for the agreed total (not offered in the app yet: online payment is "coming soon"). The Idempotency-Key is kept until the attempt ends, so a retry after a lost answer returns the
  /// same attempt instead of starting a second payment. Taps while it runs share one request.
  Future<PaymentAttempt?> pay() => _paying ??= _pay().whenComplete(() {
    _paying = null;
    notifyListeners();
  });

  Future<PaymentAttempt?> _pay() async {
    _failure = null;
    notifyListeners();
    final key = _payKey ??= 'pay-${_hex(12)}';
    try {
      final attempt = await auth.authorized(
        (t) => api.startPayment(t, bookingId, idempotencyKey: key),
      );
      _attempt = attempt;
      if (!attempt.isOpen) {
        _payKey =
            null; // finished (failed / expired / done): the next try is a new attempt
      }
      return attempt;
    } on ApiException catch (e) {
      final failure = _classify(e);
      _failure = failure;
      // a definite answer from the server ends this attempt; no answer keeps the key so the retry is the same payment
      if (e.status != 0 && e.status < 500) _payKey = null;
      if (failure.problem == ActionProblem.alreadyPaid ||
          failure.problem == ActionProblem.notPayable) {
        unawaited(load());
      }
      return null;
    }
  }

  /// Asks the server where the booking and the open payment stand (after the customer has been to the checkout).
  Future<void> refreshPayment() async {
    final current = _attempt;
    if (current != null) {
      try {
        _attempt = await auth.authorized((t) => api.payment(t, current.id));
        if (!_attempt!.isOpen) _payKey = null;
      } on ApiException {
        // keep the last known attempt; the booking status below is what decides "paid"
      }
    }
    await load();
  }

  String _hex(int bytes) => List.generate(
    bytes,
    (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();

  ActionFailure _classify(ApiException e) {
    if (e.status == 0) return const ActionFailure(ActionProblem.network);
    if (e.isUnauthorized || e.code == 'NO_SESSION') {
      return const ActionFailure(ActionProblem.notSignedIn);
    }
    switch (e.code) {
      case 'QUOTE_CHANGED':
        return const ActionFailure(ActionProblem.quoteChanged);
      case 'PAYMENT_PROVIDER_NOT_CONFIGURED':
        return const ActionFailure(ActionProblem.paymentsNotConfigured);
      case 'BOOKING_ALREADY_PAID':
        return const ActionFailure(ActionProblem.alreadyPaid);
      case 'BOOKING_NOT_PAYABLE':
        return const ActionFailure(ActionProblem.notPayable);
      case 'PAYMENT_DEADLINE_PASSED':
        return const ActionFailure(ActionProblem.deadlinePassed);
      case 'WORKER_UNAVAILABLE':
        return const ActionFailure(ActionProblem.workerUnavailable);
      case 'PAYMENT_IN_PROGRESS':
        return const ActionFailure(ActionProblem.paymentInProgress);
      case 'BOOKING_NOT_OPEN':
      case 'QUOTE_NOT_ACCEPTABLE':
      case 'QUOTE_EXPIRED':
        return const ActionFailure(ActionProblem.notAvailable);
    }
    if (e.status == 404) return const ActionFailure(ActionProblem.notAvailable);
    if (e.status == 429 || e.status >= 500) {
      return const ActionFailure(ActionProblem.busy);
    }
    return ActionFailure(ActionProblem.other, message: e.message);
  }
}
