import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

import '../../location/models/picked_location.dart';
import 'booking_schedule.dart';

/// Everything the customer chose, as the app holds it.
class BookingDraft {
  const BookingDraft({
    this.serviceId,
    this.cityId,
    this.description = '',
    this.location,
    this.asap = false,
    this.dayIndex = 0,
    this.slotIndex = -1,
  });

  final String? serviceId;
  final String? cityId;
  final String description;
  final PickedLocation? location;
  final bool asap;
  final int dayIndex;
  final int slotIndex;

  /// The backend's minimum description length (`CreateBookingDto.problemDescription`).
  static const minDescription = 10;
  static const maxDescription = 2000;

  /// What is still missing, as stable keys the screen can name.
  List<String> missing() => [
    if (serviceId == null) 'service',
    if (cityId == null) 'city',
    if (location == null) 'location',
    if (description.trim().length < minDescription ||
        description.trim().length > maxDescription)
      'description',
    if (!asap && slotIndex < 0) 'schedule',
  ];

  String get fingerprint =>
      '$serviceId|$cityId|${description.trim()}|${location?.latitude},${location?.longitude}|${location?.address}|$asap|$dayIndex|$slotIndex';
}

enum SubmitProblem {
  /// Something required is missing (see [SubmitFailure.missing]); nothing was sent.
  incomplete,

  /// The chosen time can no longer be booked; nothing was sent.
  timePassed,
  notSignedIn,

  /// The backend refused the content (field messages in [SubmitFailure.fieldMessages]).
  validation,

  /// The backend refused the schedule (its message is in [SubmitFailure.message]).
  scheduleRejected,
  serviceUnavailable,
  cityUnavailable,

  /// The customer already has the maximum number of open requests.
  limitReached,
  network,
  unavailable,
  other,
}

class SubmitFailure {
  const SubmitFailure(
    this.problem, {
    this.message,
    this.fieldMessages = const [],
    this.missing = const [],
  });
  final SubmitProblem problem;
  final String? message;
  final List<String> fieldMessages;
  final List<String> missing;
}

/// Sends the booking request and protects against creating it twice.
///
/// The backend has NO idempotency key, so duplicates are prevented here:
///  * while a request is in flight further taps do nothing (the same future is returned);
///  * once a booking was created, [submit] returns it and never sends again until [reset];
///  * if an attempt ended without an answer (connection lost, timeout, server error) the request may or may not have been created. The next
///    attempt first asks the backend for the customer's recent bookings and adopts a matching one (same service, city and window, created
///    since the attempt began) instead of sending again. If that check itself cannot be made, nothing is sent.
class BookingSubmitter extends ChangeNotifier {
  BookingSubmitter({
    required this.api,
    required this.auth,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final HsApi api;
  final AuthController auth;
  final DateTime Function() _clock;

  Future<BookingView?>? _inFlight;
  BookingView? _created;
  SubmitFailure? _failure;
  _PendingAttempt? _pending;

  bool get busy => _inFlight != null;
  BookingView? get created => _created;
  SubmitFailure? get failure => _failure;

  /// Starts over for a new booking.
  void reset() {
    if (_inFlight != null) {
      return; // never forget an attempt that is still running
    }
    _created = null;
    _failure = null;
    _pending = null;
    notifyListeners();
  }

  /// Returns the created booking, or null with [failure] set.
  Future<BookingView?> submit(BookingDraft draft) {
    final running = _inFlight;
    if (running != null) return running;
    final done = _created;
    if (done != null) return Future.value(done);
    final future = _run(draft).whenComplete(() {
      _inFlight = null;
      notifyListeners();
    });
    _inFlight = future;
    notifyListeners();
    return future;
  }

  Future<BookingView?> _run(BookingDraft draft) async {
    _failure = null;
    final missing = draft.missing();
    if (missing.isNotEmpty) {
      return _fail(SubmitFailure(SubmitProblem.incomplete, missing: missing));
    }
    final location = draft.location!;
    if (!PickedLocation.validCoordinates(
      location.latitude,
      location.longitude,
    )) {
      return _fail(
        const SubmitFailure(SubmitProblem.incomplete, missing: ['location']),
      );
    }
    final now = _clock();

    // Same content as an attempt that ended without an answer: keep its window, and look for it before sending anything.
    final pending =
        _pending != null && _pending!.fingerprint == draft.fingerprint
        ? _pending
        : null;
    if (_pending != null && pending == null) {
      _pending = null; // the customer changed the request: a new request
    }
    BookingWindow? window = pending?.window;
    if (window == null ||
        !window.start.isAfter(
          now.toUtc().add(
            const Duration(minutes: kMinLeadMinutes + kLeadMarginMinutes),
          ),
        )) {
      final resolved = resolveWindow(
        asap: draft.asap,
        dayIndex: draft.dayIndex,
        slotIndex: draft.slotIndex,
        nowUtc: now,
      );
      if (resolved.window == null) {
        final p = resolved.problem == ScheduleProblem.tooSoon
            ? SubmitProblem.timePassed
            : SubmitProblem.incomplete;
        return _fail(
          SubmitFailure(
            p,
            missing: p == SubmitProblem.incomplete
                ? const ['schedule']
                : const [],
          ),
        );
      }
      window = resolved.window!;
    }

    if (pending != null) {
      try {
        final found = await _findCreated(pending, draft, window);
        if (found != null) return _succeed(found);
      } on ApiException catch (e) {
        return _fail(_classify(e)); // cannot rule out a duplicate: do not send
      }
    }

    final request = CreateBookingRequest(
      serviceId: draft.serviceId!,
      cityId: draft.cityId!,
      problemDescription: draft.description.trim(),
      preferredStartAt: window.start,
      preferredEndAt: window.end,
      isUrgent: window.isUrgent,
      locationFields: location.toBookingFields(),
    );
    final attempt =
        pending ??
        _PendingAttempt(
          fingerprint: draft.fingerprint,
          startedAt: now.toUtc(),
          window: window,
        );
    try {
      final view = await auth.authorized(
        (token) => api.createBooking(token, request),
      );
      return _succeed(view);
    } on ApiException catch (e) {
      final failure = _classify(e);
      // An answer from the server means it did not create the booking. No answer (or a server error) means we cannot know.
      _pending = _ambiguous(e) ? attempt : null;
      return _fail(failure);
    }
  }

  Future<BookingView?> _findCreated(
    _PendingAttempt attempt,
    BookingDraft draft,
    BookingWindow window,
  ) async {
    final list = await auth.authorized(
      (token) => api.myBookings(
        token,
        statuses: const ['OPEN'],
        createdFrom: attempt.startedAt.subtract(const Duration(seconds: 30)),
        limit: 20,
      ),
    );
    bool near(DateTime? a, DateTime b) =>
        a != null && a.difference(b).inSeconds.abs() <= 1;
    for (final b in list) {
      if (b.serviceId == draft.serviceId &&
          b.cityId == draft.cityId &&
          near(b.preferredStartAt, attempt.window.start) &&
          near(b.preferredEndAt, attempt.window.end)) {
        return BookingView(
          id: b.id,
          reference: b.reference,
          status: b.status,
          location: BookingLocation(cityId: b.cityId),
          preferredStartAt: b.preferredStartAt,
          preferredEndAt: b.preferredEndAt,
        );
      }
    }
    return null;
  }

  BookingView _succeed(BookingView view) {
    _created = view;
    _pending = null;
    _failure = null;
    return view;
  }

  BookingView? _fail(SubmitFailure f) {
    _failure = f;
    return null;
  }

  bool _ambiguous(ApiException e) => e.status == 0 || e.status >= 500;

  SubmitFailure _classify(ApiException e) {
    if (e.status == 0) return const SubmitFailure(SubmitProblem.network);
    if (e.isUnauthorized || e.code == 'NO_SESSION') {
      return const SubmitFailure(SubmitProblem.notSignedIn);
    }
    switch (e.code) {
      case 'INVALID_SCHEDULE':
        return SubmitFailure(
          SubmitProblem.scheduleRejected,
          message: e.message,
        );
      case 'INVALID_SERVICE':
        return const SubmitFailure(SubmitProblem.serviceUnavailable);
      case 'INVALID_CITY':
        return const SubmitFailure(SubmitProblem.cityUnavailable);
      case 'BOOKING_LIMIT':
        return const SubmitFailure(SubmitProblem.limitReached);
    }
    if (e.status == 400) {
      return SubmitFailure(
        SubmitProblem.validation,
        message: e.message,
        fieldMessages: e.fieldMessages,
      );
    }
    if (e.status == 429 || e.status >= 500) {
      return const SubmitFailure(SubmitProblem.unavailable);
    }
    return const SubmitFailure(SubmitProblem.other);
  }
}

class _PendingAttempt {
  const _PendingAttempt({
    required this.fingerprint,
    required this.startedAt,
    required this.window,
  });
  final String fingerprint;
  final DateTime startedAt;
  final BookingWindow window;
}
