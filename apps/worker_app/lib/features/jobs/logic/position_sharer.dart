import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:hs_client/hs_client.dart';

import 'worker_jobs_controller.dart';

/// Where the phone stands on location. Sharing needs the person's permission; every state other than [granted] simply means the customer
/// does not see the worker on the map, and nothing else in the app depends on it.
enum PositionAccess { granted, denied, deniedForever, serviceOff, unavailable }

class PositionReading {
  const PositionReading({
    required this.latitude,
    required this.longitude,
    required this.at,
    this.accuracyMeters,
    this.headingDegrees,
    this.speedMps,
  });
  final double latitude;
  final double longitude;
  final DateTime at;
  final double? accuracyMeters;
  final double? headingDegrees;
  final double? speedMps;
}

/// The phone's location, behind an interface so sharing is testable without the platform.
abstract class PositionSource {
  Future<PositionAccess> status();
  Future<PositionAccess> request();
  Future<PositionReading?> current();
  Future<void> openSettings();
}

class GeolocatorPositionSource implements PositionSource {
  const GeolocatorPositionSource();

  PositionAccess _map(LocationPermission p) => switch (p) {
    LocationPermission.always ||
    LocationPermission.whileInUse => PositionAccess.granted,
    LocationPermission.deniedForever => PositionAccess.deniedForever,
    _ => PositionAccess.denied,
  };

  @override
  Future<PositionAccess> status() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return PositionAccess.serviceOff;
      }
      return _map(await Geolocator.checkPermission());
    } catch (_) {
      return PositionAccess.unavailable;
    }
  }

  @override
  Future<PositionAccess> request() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return PositionAccess.serviceOff;
      }
      var p = await Geolocator.checkPermission();
      if (p == LocationPermission.denied) {
        p = await Geolocator.requestPermission();
      }
      return _map(p);
    } catch (_) {
      return PositionAccess.unavailable;
    }
  }

  @override
  Future<PositionReading?> current() async {
    try {
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
      return PositionReading(
        latitude: p.latitude,
        longitude: p.longitude,
        at: p.timestamp,
        accuracyMeters: p.accuracy,
        headingDegrees: p.heading >= 0 && p.heading <= 360 ? p.heading : null,
        speedMps: p.speed >= 0 ? p.speed : null,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> openSettings() async {
    await Geolocator.openAppSettings();
  }
}

enum SharingState {
  /// No paid job needs the position right now.
  idle,

  /// The position is being sent to the customer.
  sharing,

  /// There is a job to share for, but the person has not allowed location (or the phone's location is off).
  needsPermission,

  /// There is a job to share for, but no position could be read or sent just now.
  trying,
}

/// Keeps the customer's map current: while a paid job is waiting for the worker (CONFIRMED, close to its time) or under way (IN_PROGRESS) and
/// the app is open, it reads the phone's position every [interval] and sends it to the backend. The backend decides whether sharing is open
/// and refuses implausible, stale or too frequent readings; a refusal is simply skipped. It stops when the job finishes, the worker signs
/// out, or the app goes to the background (sharing in the background needs a foreground service, which this app does not run).
class PositionSharer extends ChangeNotifier {
  PositionSharer({
    required this.api,
    required this.auth,
    required this.jobs,
    required this.source,
    this.interval = const Duration(seconds: 10),
    this.lead = const Duration(hours: 3),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final HsApi api;
  final AuthController auth;
  final WorkerJobsController jobs;
  final PositionSource source;
  final Duration interval;

  /// How long before the visit a paid job starts sharing. Matches the backend's default window; the backend has the final say.
  final Duration lead;
  final DateTime Function() _clock;

  Timer? _timer;
  bool _foreground = true;
  bool _ticking = false;
  bool _asked = false;
  bool _disposed = false;
  SharingState _state = SharingState.idle;
  PositionAccess? _access;
  DateTime? _lastSentAt;
  final Map<String, DateTime> _pausedUntil = {};

  SharingState get state => _state;
  PositionAccess? get access => _access;
  DateTime? get lastSentAt => _lastSentAt;

  /// Whether this job is one the customer expects to see the worker for.
  bool wantsPosition(WorkerJob job) {
    if (job.status == 'IN_PROGRESS') return true;
    if (job.status != 'CONFIRMED') return false;
    final start = job.preferredStartAt;
    return start == null || start.difference(_clock().toUtc()) <= lead;
  }

  List<WorkerJob> get _active => [
    for (final j in jobs.jobs)
      if (wantsPosition(j)) j,
  ];

  /// Asks the phone for location permission once, as soon as a worker is signed in, instead of waiting for the first job that needs it.
  /// Saying no is fine: the worker can still quote; only live location on a job needs it, and the job screen offers to ask again.
  Future<void> _askOnce() async {
    if (_asked || _disposed || !auth.isSignedIn) return;
    _asked = true;
    _access = await source.request();
  }

  void start() {
    _timer ??= Timer.periodic(interval, (_) => unawaited(tick()));
    unawaited(_askOnce().then((_) => tick()));
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _set(SharingState.idle);
  }

  void setForeground(bool value) {
    _foreground = value;
    if (value) unawaited(tick());
  }

  /// Asks again (a button in the job screen), or opens the settings when the person chose "don't ask again".
  Future<void> fixPermission() async {
    if (_access == PositionAccess.deniedForever ||
        _access == PositionAccess.serviceOff) {
      await source.openSettings();
    } else {
      _access = await source.request();
    }
    await tick();
  }

  /// One round: read the position and send it for each job that needs it. Rounds never overlap.
  Future<void> tick() async {
    // only an approved worker has jobs (the backend refuses the job list to anyone else)
    if (_ticking || _disposed || !_foreground || !auth.isSignedIn) return;
    if (auth.user?.workerVerificationStatus != 'APPROVED') return;
    _ticking = true;
    try {
      if (jobs.jobsStatus == LoadStatus.idle) await jobs.loadJobs();
      final now = _clock();
      final active = _active
          .where(
            (j) =>
                (_pausedUntil[j.id] ?? DateTime.fromMillisecondsSinceEpoch(0))
                    .isBefore(now),
          )
          .toList();
      if (_active.isEmpty) {
        _set(SharingState.idle);
        return;
      }
      if (active.isEmpty) return; // all paused after a refusal: try again later
      _access = _asked ? await source.status() : await source.request();
      _asked = true;
      if (_access != PositionAccess.granted) {
        _set(SharingState.needsPermission);
        return;
      }
      final reading = await source.current();
      if (reading == null) {
        _set(SharingState.trying);
        return;
      }
      var sent = false;
      for (final job in active) {
        try {
          await auth.authorized(
            (t) => api.reportPosition(
              t,
              job.id,
              latitude: reading.latitude,
              longitude: reading.longitude,
              recordedAt: reading.at,
              accuracyMeters: reading.accuracyMeters,
              headingDegrees: reading.headingDegrees,
              speedMps: reading.speedMps,
            ),
          );
          sent = true;
        } on ApiException catch (e) {
          // Sharing is not open for this job yet / any more: stop asking for a while instead of every few seconds. Everything else (a flood
          // limit, a reading the server found implausible, no connection) is just skipped; the next round sends a fresh one.
          if (e.code == 'LOCATION_SHARING_NOT_ACTIVE') {
            _pausedUntil[job.id] = now.add(const Duration(seconds: 60));
          }
          if (e.status == 404) {
            _pausedUntil[job.id] = now.add(const Duration(minutes: 5));
          }
        }
      }
      if (sent) _lastSentAt = now;
      _set(sent ? SharingState.sharing : SharingState.trying);
    } finally {
      _ticking = false;
    }
  }

  void _set(SharingState next) {
    if (_state == next || _disposed) return;
    _state = next;
    notifyListeners();
  }

  /// Forgets everything (sign-out).
  void reset() {
    _pausedUntil.clear();
    _asked = false;
    _access = null;
    _lastSentAt = null;
    _set(SharingState.idle);
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
