import 'package:flutter/foundation.dart';
import 'package:hs_client/hs_client.dart';

import '../../app/localization/app_strings.dart';
import '../../core/constants/icon_paths.dart';
import '../../shared/models/service.dart';

enum CatalogStatus { idle, loading, ready, failed }

/// The services and cities customers can book, loaded from the backend's public catalog (`GET /catalog`, `GET /catalog/cities`).
///
/// A service's id here is the backend's UUID: that is what a booking request carries. Nothing is invented for display: the catalog has a
/// name and a description, no price or rating, so [Service] built from it leaves those empty and the screens hide them.
class CatalogController extends ChangeNotifier {
  CatalogController({required this._load});

  final Future<Catalog> Function() _load;

  CatalogStatus _status = CatalogStatus.idle;
  Catalog? _catalog;
  ApiException? _error;
  Future<void>? _loading;

  CatalogStatus get status => _status;
  ApiException? get error => _error;
  bool get isReady => _status == CatalogStatus.ready;

  List<ServiceCategory> get categories => [
    for (final c in _catalog?.categories ?? const <CatalogCategory>[])
      if (c.services.isNotEmpty)
        ServiceCategory(
          c.id,
          Bi(c.nameEn, c.nameAr.isEmpty ? c.nameEn : c.nameAr),
          _iconFor(c),
        ),
  ];

  List<Service> get services => [
    for (final c in _catalog?.categories ?? const <CatalogCategory>[])
      for (final s in c.services)
        Service(
          id: s.id,
          category: c.id,
          name: Bi(s.nameEn, s.nameAr.isEmpty ? s.nameEn : s.nameAr),
          description: Bi(
            s.descriptionEn ?? '',
            (s.descriptionAr?.isNotEmpty ?? false)
                ? s.descriptionAr!
                : (s.descriptionEn ?? ''),
          ),
          icon: _iconFor(c),
        ),
  ];

  List<City> get cities => _catalog?.cities ?? const [];

  Service? serviceById(String? id) {
    if (id == null) return null;
    for (final s in services) {
      if (s.id == id) return s;
    }
    return null;
  }

  /// Loads the catalog; calls while a load is running share it. A failure keeps what was loaded before.
  Future<void> load({bool force = false}) {
    if (!force && _status == CatalogStatus.ready) return Future.value();
    return _loading ??= _doLoad().whenComplete(() => _loading = null);
  }

  Future<void> _doLoad() async {
    _status = CatalogStatus.loading;
    _error = null;
    notifyListeners();
    try {
      _catalog = await _load();
      _status = CatalogStatus.ready;
    } on ApiException catch (e) {
      _error = e;
      _status = _catalog == null ? CatalogStatus.failed : CatalogStatus.ready;
    }
    notifyListeners();
  }

  /// An icon the app has: the category's own key if known, otherwise a guess from its name, otherwise a generic tool.
  String _iconFor(CatalogCategory c) {
    final key = c.iconKey;
    if (key != null && kIconPaths.containsKey(key)) return key;
    final text = '${c.slug} ${c.nameEn}'.toLowerCase();
    if (text.contains('elec')) return 'zap';
    if (text.contains('plumb') || text.contains('water')) return 'droplet';
    if (text.contains('ac') || text.contains('air') || text.contains('cool')) {
      return 'snowflake';
    }
    return 'wrench';
  }
}
