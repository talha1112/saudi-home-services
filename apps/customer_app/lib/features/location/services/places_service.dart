import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../../../core/config/maps_config.dart';

/// Why a Places or Geocoding request did not give an answer, in terms the screen can turn into a message. Never carries the key or a URL.
enum PlacesFailure {
  notConfigured,
  quota,
  denied,
  invalid,
  network,
  unavailable,
}

class PlacesException implements Exception {
  const PlacesException(this.failure);
  final PlacesFailure failure;
  @override
  String toString() => 'PlacesException($failure)';
}

class PlaceSuggestion {
  const PlaceSuggestion({
    required this.placeId,
    required this.primary,
    this.secondary,
  });
  final String placeId;

  /// Name or street, e.g. "King Fahd Road".
  final String primary;

  /// Area, e.g. "Al Olaya, Riyadh".
  final String? secondary;
}

/// An address resolved from a place or from coordinates.
class ResolvedAddress {
  const ResolvedAddress({
    required this.address,
    this.latitude,
    this.longitude,
    this.placeId,
    this.district,
    this.city,
  });
  final String address;
  final double? latitude;
  final double? longitude;
  final String? placeId;
  final String? district;
  final String? city;
}

/// Address search and reverse geocoding. Behind an interface so the screen is testable without the network.
abstract class PlacesService {
  Future<List<PlaceSuggestion>> autocomplete(
    String query, {
    required String sessionToken,
    required String languageCode,
    double? biasLatitude,
    double? biasLongitude,
  });

  /// The chosen suggestion's details. Using the same [sessionToken] as the autocomplete calls bills the whole search as one session.
  Future<ResolvedAddress> details(
    String placeId, {
    required String sessionToken,
    required String languageCode,
  });

  /// The address at [latitude], [longitude], or null when Google knows of none (open desert, sea).
  Future<ResolvedAddress?> reverseGeocode(
    double latitude,
    double longitude, {
    required String languageCode,
  });
}

/// A random session token (UUID v4 shape) for one search: it ties the autocomplete requests and the final details call together.
String newSessionToken([Random? random]) {
  final r = random ?? Random.secure();
  String hex(int n) =>
      List.generate(n, (_) => r.nextInt(16).toRadixString(16)).join();
  return '${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + r.nextInt(4)).toRadixString(16)}${hex(3)}-${hex(12)}';
}

/// Google Places API (New) and Geocoding API over HTTPS.
///
/// The key is sent in a header (Places) or the query string (Geocoding, which has no header option); it is never logged and never put in an
/// exception. Mobile keys are extractable from the app: restrict the key before release (see docs/GOOGLE_MAPS_SETUP.md).
class GooglePlacesService implements PlacesService {
  GooglePlacesService({
    String? apiKey,
    http.Client? client,
    this.timeout = const Duration(seconds: 12),
  }) : _key = apiKey ?? kMapsApiKey,
       _client = client ?? http.Client();

  final String _key;
  final http.Client _client;
  final Duration timeout;

  static const _places = 'https://places.googleapis.com/v1';
  static const _geocode = 'https://maps.googleapis.com/maps/api/geocode/json';

  void _requireKey() {
    if (_key.isEmpty) throw const PlacesException(PlacesFailure.notConfigured);
  }

  @override
  Future<List<PlaceSuggestion>> autocomplete(
    String query, {
    required String sessionToken,
    required String languageCode,
    double? biasLatitude,
    double? biasLongitude,
  }) async {
    _requireKey();
    final body = <String, Object?>{
      'input': query,
      'sessionToken': sessionToken,
      'languageCode': languageCode,
      'includedRegionCodes': ['sa'], // Saudi Arabia only
      if (biasLatitude != null && biasLongitude != null)
        'locationBias': {
          'circle': {
            'center': {'latitude': biasLatitude, 'longitude': biasLongitude},
            'radius': 50000.0,
          },
        },
    };
    final json = await _send(
      () => _client.post(
        Uri.parse('$_places/places:autocomplete'),
        headers: {'content-type': 'application/json', 'X-Goog-Api-Key': _key},
        body: jsonEncode(body),
      ),
    );
    final out = <PlaceSuggestion>[];
    for (final s in (json['suggestions'] as List<dynamic>? ?? const [])) {
      final p =
          (s as Map<String, dynamic>)['placePrediction']
              as Map<String, dynamic>?;
      final id = p?['placeId'] as String?;
      if (p == null || id == null) continue;
      final structured = p['structuredFormat'] as Map<String, dynamic>?;
      final main =
          (structured?['mainText'] as Map<String, dynamic>?)?['text']
              as String?;
      final secondary =
          (structured?['secondaryText'] as Map<String, dynamic>?)?['text']
              as String?;
      final full = (p['text'] as Map<String, dynamic>?)?['text'] as String?;
      out.add(
        PlaceSuggestion(
          placeId: id,
          primary: main ?? full ?? '',
          secondary: secondary,
        ),
      );
    }
    return out;
  }

  @override
  Future<ResolvedAddress> details(
    String placeId, {
    required String sessionToken,
    required String languageCode,
  }) async {
    _requireKey();
    final uri = Uri.parse('$_places/places/${Uri.encodeComponent(placeId)}')
        .replace(
          queryParameters: {
            'sessionToken': sessionToken,
            'languageCode': languageCode,
          },
        );
    final json = await _send(
      () => _client.get(
        uri,
        headers: {
          'X-Goog-Api-Key': _key,
          'X-Goog-FieldMask':
              'id,displayName,formattedAddress,location,addressComponents',
        },
      ),
    );
    final loc = json['location'] as Map<String, dynamic>?;
    final lat = (loc?['latitude'] as num?)?.toDouble();
    final lng = (loc?['longitude'] as num?)?.toDouble();
    if (lat == null || lng == null) {
      throw const PlacesException(PlacesFailure.invalid);
    }
    final comps = [
      for (final c in (json['addressComponents'] as List<dynamic>? ?? const []))
        (
          name: (c as Map<String, dynamic>)['longText'] as String? ?? '',
          types: [
            for (final t in (c['types'] as List<dynamic>? ?? const [])) '$t',
          ],
        ),
    ];
    return ResolvedAddress(
      address:
          (json['formattedAddress'] as String?) ??
          ((json['displayName'] as Map<String, dynamic>?)?['text'] as String? ??
              ''),
      latitude: lat,
      longitude: lng,
      placeId: json['id'] as String? ?? placeId,
      district: _pick(comps, const [
        'sublocality_level_1',
        'sublocality',
        'neighborhood',
      ]),
      city: _pick(comps, const [
        'locality',
        'administrative_area_level_2',
        'administrative_area_level_1',
      ]),
    );
  }

  @override
  Future<ResolvedAddress?> reverseGeocode(
    double latitude,
    double longitude, {
    required String languageCode,
  }) async {
    _requireKey();
    final uri = Uri.parse(_geocode).replace(
      queryParameters: {
        'latlng': '$latitude,$longitude',
        'language': languageCode,
        'region': 'sa',
        'key': _key,
      },
    );
    final json = await _send(() => _client.get(uri));
    switch (json['status'] as String?) {
      case 'OK':
        break;
      case 'ZERO_RESULTS':
        return null;
      case 'OVER_QUERY_LIMIT' || 'OVER_DAILY_LIMIT':
        throw const PlacesException(PlacesFailure.quota);
      case 'REQUEST_DENIED':
        throw const PlacesException(PlacesFailure.denied);
      case 'INVALID_REQUEST':
        throw const PlacesException(PlacesFailure.invalid);
      default:
        throw const PlacesException(PlacesFailure.unavailable);
    }
    final results = json['results'] as List<dynamic>? ?? const [];
    if (results.isEmpty) return null;
    final first = results.first as Map<String, dynamic>;
    final comps = [
      for (final c
          in (first['address_components'] as List<dynamic>? ?? const []))
        (
          name: (c as Map<String, dynamic>)['long_name'] as String? ?? '',
          types: [
            for (final t in (c['types'] as List<dynamic>? ?? const [])) '$t',
          ],
        ),
    ];
    final address = first['formatted_address'] as String?;
    if (address == null || address.isEmpty) return null;
    return ResolvedAddress(
      address: address,
      latitude: latitude,
      longitude: longitude,
      placeId: first['place_id'] as String?,
      district: _pick(comps, const [
        'sublocality_level_1',
        'sublocality',
        'neighborhood',
      ]),
      city: _pick(comps, const [
        'locality',
        'administrative_area_level_2',
        'administrative_area_level_1',
      ]),
    );
  }

  static String? _pick(
    List<({String name, List<String> types})> comps,
    List<String> order,
  ) {
    for (final type in order) {
      for (final c in comps) {
        if (c.types.contains(type) && c.name.isNotEmpty) return c.name;
      }
    }
    return null;
  }

  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function() call,
  ) async {
    http.Response res;
    try {
      res = await call().timeout(timeout);
    } on TimeoutException {
      throw const PlacesException(PlacesFailure.network);
    } on SocketException {
      throw const PlacesException(PlacesFailure.network);
    } on http.ClientException {
      throw const PlacesException(PlacesFailure.network);
    }
    if (res.statusCode == 429) throw const PlacesException(PlacesFailure.quota);
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw const PlacesException(PlacesFailure.denied);
    }
    if (res.statusCode == 400 || res.statusCode == 404) {
      throw const PlacesException(PlacesFailure.invalid);
    }
    if (res.statusCode >= 500 ||
        res.statusCode < 200 ||
        res.statusCode >= 300) {
      throw const PlacesException(PlacesFailure.unavailable);
    }
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      return decoded is Map<String, dynamic> ? decoded : const {};
    } on FormatException {
      throw const PlacesException(PlacesFailure.unavailable);
    }
  }

  void close() => _client.close();
}
