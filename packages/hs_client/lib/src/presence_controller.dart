import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'errors.dart';
import 'worker_models.dart';

/// The worker's online switch (home tab): whether new requests reach them, and the cities they serve (shown beside the switch).
/// The server decides: an offline worker is shown no new requests and gets no new-request pushes.
class PresenceController extends ChangeNotifier {
  PresenceController({required this.api, required this.auth});

  final HsApi api;
  final AuthController auth;

  bool _online = true;
  bool _loaded = false;
  bool _busy = false;
  List<City> _cities = const [];
  ApiException? _error;
  Future<void>? _loading;
  bool _disposed = false;

  bool get online => _online;

  /// False until the server has answered once (the switch is not shown before that).
  bool get loaded => _loaded;
  bool get busy => _busy;
  List<City> get cities => _cities;

  /// Set when the last switch was refused or failed; the switch is back where it was.
  ApiException? get error => _error;

  Future<void> load() => _loading ??= _doLoad().whenComplete(() => _loading = null);

  Future<void> _doLoad() async {
    try {
      final data = await auth.authorized((t) => api.workerOnboarding(t));
      _online = data.profile.isOnline;
      _cities = data.cities;
      _loaded = true;
    } catch (_) {
      // keep what was shown; the next refresh tries again
    }
    _tell();
  }

  /// Switches at once on screen, then on the server; a refusal puts the switch back.
  Future<void> setOnline(bool value) async {
    if (_busy || value == _online) return;
    final before = _online;
    _online = value;
    _busy = true;
    _error = null;
    _tell();
    try {
      _online = await auth.authorized((t) => api.setWorkerOnline(t, value));
    } on ApiException catch (e) {
      _online = before;
      _error = e;
    }
    _busy = false;
    _tell();
  }

  void _tell() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
