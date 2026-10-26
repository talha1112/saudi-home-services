import 'package:flutter/foundation.dart';

import 'account_models.dart';
import 'api_client.dart';
import 'auth_controller.dart';
import 'errors.dart';

enum FeedStatus { idle, loading, ready, failed }

/// The signed-in person's notifications (`GET /notifications`) and how many are unread, for the bell and the list. Both apps use it.
class NotificationsController extends ChangeNotifier {
  NotificationsController({required this.api, required this.auth});

  final HsApi api;
  final AuthController auth;

  FeedStatus _status = FeedStatus.idle;
  List<NotificationItem> _items = const [];
  int _unread = 0;
  ApiException? _error;
  Future<void>? _loading;
  Future<void>? _counting;
  bool _disposed = false;

  FeedStatus get status => _status;
  List<NotificationItem> get items => _items;

  /// The number the server counted last (the whole account, not only the entries loaded).
  int get unread => _unread;
  ApiException? get error => _error;

  /// Loads the list and the unread count. Calls while a load is running share it; a failed refresh keeps what was shown.
  Future<void> load() => _loading ??= _doLoad().whenComplete(() => _loading = null);

  Future<void> _doLoad() async {
    _status = _items.isEmpty ? FeedStatus.loading : _status;
    _error = null;
    _tell();
    try {
      final page = await auth.authorized((t) => api.notifications(t));
      final unread = await auth.authorized((t) => api.unreadNotifications(t));
      _items = page.items;
      _unread = unread;
      _status = FeedStatus.ready;
    } on ApiException catch (e) {
      _error = e;
      _status = _items.isEmpty ? FeedStatus.failed : FeedStatus.ready;
    }
    _tell();
  }

  /// Only the badge number (cheap enough to ask whenever the home screen is shown or a push arrives).
  Future<void> refreshUnread() => _counting ??= _doCount().whenComplete(() => _counting = null);

  Future<void> _doCount() async {
    try {
      _unread = await auth.authorized((t) => api.unreadNotifications(t));
      _tell();
    } on ApiException {
      // The badge keeps its old number.
    }
  }

  /// Marks one as read at once on screen, then on the server. If the server refuses, the entry goes back to unread.
  Future<void> markRead(NotificationItem item) async {
    if (item.read) return;
    final before = _items;
    final beforeUnread = _unread;
    _items = [for (final n in _items) n.id == item.id ? n.asRead() : n];
    _unread = _unread > 0 ? _unread - 1 : 0;
    _tell();
    try {
      await auth.authorized((t) => api.markNotificationRead(t, item.id));
    } on ApiException {
      _items = before;
      _unread = beforeUnread;
      _tell();
    }
  }

  Future<void> markAllRead() async {
    if (_unread == 0 && _items.every((n) => n.read)) return;
    final before = _items;
    final beforeUnread = _unread;
    _items = [for (final n in _items) n.asRead()];
    _unread = 0;
    _tell();
    try {
      await auth.authorized((t) => api.markAllNotificationsRead(t));
    } on ApiException {
      _items = before;
      _unread = beforeUnread;
      _tell();
    }
  }

  /// Forgets everything (on sign-out), so the next account never sees this one's list.
  void clear() {
    _items = const [];
    _unread = 0;
    _error = null;
    _status = FeedStatus.idle;
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

/// The offers published for this person (`GET /offers`).
class OffersController extends ChangeNotifier {
  OffersController({required this.api, required this.auth});

  final HsApi api;
  final AuthController auth;

  FeedStatus _status = FeedStatus.idle;
  List<OfferItem> _items = const [];
  ApiException? _error;
  Future<void>? _loading;
  bool _disposed = false;

  FeedStatus get status => _status;
  List<OfferItem> get items => _items;
  ApiException? get error => _error;

  Future<void> load() => _loading ??= _doLoad().whenComplete(() => _loading = null);

  Future<void> _doLoad() async {
    _status = _items.isEmpty ? FeedStatus.loading : _status;
    _error = null;
    _tell();
    try {
      _items = await auth.authorized(api.offers);
      _status = FeedStatus.ready;
    } on ApiException catch (e) {
      _error = e;
      _status = _items.isEmpty ? FeedStatus.failed : FeedStatus.ready;
    }
    _tell();
  }

  void clear() {
    _items = const [];
    _error = null;
    _status = FeedStatus.idle;
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

/// A worker's own reviews and average (`GET /reviews/received`).
class ReviewsController extends ChangeNotifier {
  ReviewsController({required this.api, required this.auth});

  final HsApi api;
  final AuthController auth;

  FeedStatus _status = FeedStatus.idle;
  ReceivedReviews? _reviews;
  Future<void>? _loading;
  bool _disposed = false;

  FeedStatus get status => _status;
  ReceivedReviews? get reviews => _reviews;

  Future<void> load() => _loading ??= _doLoad().whenComplete(() => _loading = null);

  Future<void> _doLoad() async {
    _status = _reviews == null ? FeedStatus.loading : _status;
    _tell();
    try {
      _reviews = await auth.authorized(api.receivedReviews);
      _status = FeedStatus.ready;
    } on ApiException {
      _status = _reviews == null ? FeedStatus.failed : FeedStatus.ready;
    }
    _tell();
  }

  void clear() {
    _reviews = null;
    _status = FeedStatus.idle;
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
