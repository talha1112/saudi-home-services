import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

enum MyBookingsStatus { idle, loading, ready, failed }

/// The signed-in customer's own bookings, from `GET /bookings`.
class MyBookingsController extends ChangeNotifier {
  MyBookingsController({required this.api, required this.auth});

  final HsApi api;
  final AuthController auth;

  MyBookingsStatus _status = MyBookingsStatus.idle;
  List<BookingSummary> _items = const [];
  ApiException? _error;
  Future<void>? _loading;

  MyBookingsStatus get status => _status;
  List<BookingSummary> get items => _items;
  ApiException? get error => _error;

  /// Loads the list. Calls while a load is running share it; the previous list stays visible if a refresh fails.
  Future<void> load() =>
      _loading ??= _doLoad().whenComplete(() => _loading = null);

  Future<void> _doLoad() async {
    _status = MyBookingsStatus.loading;
    _error = null;
    notifyListeners();
    try {
      _items = await auth.authorized(
        (token) => api.myBookings(token, limit: 50),
      );
      _status = MyBookingsStatus.ready;
    } on ApiException catch (e) {
      _error = e;
      _status = _items.isEmpty
          ? MyBookingsStatus.failed
          : MyBookingsStatus.ready;
    }
    notifyListeners();
  }

  /// Forgets everything (on sign-out), so the next account never sees this one's list.
  void clear() {
    _items = const [];
    _error = null;
    _status = MyBookingsStatus.idle;
    notifyListeners();
  }
}
