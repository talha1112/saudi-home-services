import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

/// Where the booking's professional is, as they last shared it (`GET /bookings/:id/location`), refreshed every [interval] while the screen
/// that owns this controller is open. The server never invents a position and neither does this: when the answer is "unavailable" the
/// reason is kept and nothing is drawn. A failed refresh keeps the last position and says it is stale.
class WorkerPositionController extends ChangeNotifier {
  WorkerPositionController({
    required this.api,
    required this.auth,
    required this.bookingId,
    this.interval = const Duration(seconds: 5),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final HsApi api;
  final AuthController auth;
  final String bookingId;
  final Duration interval;
  final DateTime Function() _clock;

  Timer? _timer;
  Future<void>? _running;
  bool _disposed = false;
  bool _loaded = false;
  LiveLocation? _position;
  DateTime? _receivedAt;
  ApiException? _error;

  /// False until the first answer arrives.
  bool get loaded => _loaded;
  LiveLocation? get position => _position;
  ApiException? get error => _error;

  /// How old the shown position is, counting from when the server said it was [LiveLocation.ageSeconds] old and our own clock since.
  Duration? get age {
    final p = _position;
    if (p == null || !p.available || _receivedAt == null) return null;
    return Duration(seconds: p.ageSeconds ?? 0) +
        _clock().difference(_receivedAt!);
  }

  void start() {
    _timer ??= Timer.periodic(interval, (_) => unawaited(refresh()));
    unawaited(refresh());
  }

  /// Asks again. Calls while one is running share it.
  Future<void> refresh() =>
      _running ??= _load().whenComplete(() => _running = null);

  Future<void> _load() async {
    try {
      final next = await auth.authorized(
        (t) => api.workerPosition(t, bookingId),
      );
      _position = next;
      _receivedAt = _clock();
      _error = null;
    } on ApiException catch (e) {
      _error =
          e; // the last position (if any) stays, and is marked stale by its age
    }
    _loaded = true;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
