/// Booking shapes shared by the apps, mirroring the backend's `BookingLocationDto` / booking responses. Only what the screens need.
library;

/// Where a booking takes place, as the backend returns it.
///
/// Who sees what is decided by the backend: the owner always sees everything; a worker sees only the city and district until the booking
/// is paid, and then the street, building, notes and the exact point. A missing field simply means "not released" or "not given": the app
/// must not invent a value, and a booking without coordinates has no exact point ([hasExactPoint] is false).
class BookingLocation {
  const BookingLocation({
    required this.cityId,
    this.cityNameEn = '',
    this.cityNameAr = '',
    this.district,
    this.addressLine,
    this.building,
    this.locationNotes,
    this.latitude,
    this.longitude,
  });

  factory BookingLocation.fromJson(Map<String, dynamic> json) => BookingLocation(
    cityId: json['cityId'] as String? ?? '',
    cityNameEn: json['cityNameEn'] as String? ?? '',
    cityNameAr: json['cityNameAr'] as String? ?? '',
    district: json['district'] as String?,
    addressLine: json['addressLine'] as String?,
    building: json['building'] as String?,
    locationNotes: json['locationNotes'] as String?,
    latitude: _number(json['latitude']),
    longitude: _number(json['longitude']),
  );

  final String cityId;
  final String cityNameEn;
  final String cityNameAr;
  final String? district;
  final String? addressLine;
  final String? building;
  final String? locationNotes;
  final double? latitude;
  final double? longitude;

  /// Both coordinates are present and valid: a pin can be shown and directions opened. (0,0 is a real place in the ocean, but never a
  /// Saudi address, and the backend never stores a missing point as 0,0.)
  bool get hasExactPoint {
    final lat = latitude;
    final lng = longitude;
    return lat != null && lng != null && lat.isFinite && lng.isFinite && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  static double? _number(Object? v) => v is num ? v.toDouble() : null;
}

/// The parts of a booking the apps use: identity, state and place.
class BookingView {
  const BookingView({
    required this.id,
    required this.reference,
    required this.status,
    required this.location,
    this.preferredStartAt,
    this.preferredEndAt,
    this.expiresAt,
  });

  factory BookingView.fromJson(Map<String, dynamic> json) => BookingView(
    id: json['id'] as String,
    reference: json['reference'] as String? ?? '',
    status: json['status'] as String? ?? '',
    location: BookingLocation.fromJson(json['location'] as Map<String, dynamic>? ?? const {}),
    preferredStartAt: DateTime.tryParse(json['preferredStartAt'] as String? ?? ''),
    preferredEndAt: DateTime.tryParse(json['preferredEndAt'] as String? ?? ''),
    expiresAt: DateTime.tryParse(json['expiresAt'] as String? ?? ''),
  );

  final String id;
  final String reference;
  final DateTime? preferredStartAt;
  final DateTime? preferredEndAt;

  /// When the request lapses if no quote is chosen.
  final DateTime? expiresAt;

  /// OPEN, PAYMENT_PENDING, CONFIRMED, ... (the backend's booking states).
  final String status;
  final BookingLocation location;
}

/// One row of the customer's booking list (`GET /bookings`).
class BookingSummary {
  const BookingSummary({
    required this.id,
    required this.reference,
    required this.status,
    required this.serviceId,
    required this.serviceNameEn,
    required this.serviceNameAr,
    required this.cityId,
    required this.isUrgent,
    required this.preferredStartAt,
    required this.preferredEndAt,
    required this.createdAt,
    required this.quoteCount,
  });

  factory BookingSummary.fromJson(Map<String, dynamic> json) {
    final service = json['service'] as Map<String, dynamic>? ?? const {};
    return BookingSummary(
      id: json['id'] as String,
      reference: json['reference'] as String? ?? '',
      status: json['status'] as String? ?? '',
      serviceId: service['id'] as String? ?? '',
      serviceNameEn: service['nameEn'] as String? ?? '',
      serviceNameAr: service['nameAr'] as String? ?? '',
      cityId: json['cityId'] as String? ?? '',
      isUrgent: json['isUrgent'] as bool? ?? false,
      preferredStartAt: DateTime.tryParse(json['preferredStartAt'] as String? ?? ''),
      preferredEndAt: DateTime.tryParse(json['preferredEndAt'] as String? ?? ''),
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? ''),
      quoteCount: (json['quoteCount'] as num?)?.toInt() ?? 0,
    );
  }

  final String id;
  final String reference;
  final String status;
  final String serviceId;
  final String serviceNameEn;
  final String serviceNameAr;
  final String cityId;
  final bool isUrgent;
  final DateTime? preferredStartAt;
  final DateTime? preferredEndAt;
  final DateTime? createdAt;

  /// Quotes from workers waiting for the customer to choose.
  final int quoteCount;

  String serviceName({required bool arabic}) => arabic && serviceNameAr.isNotEmpty ? serviceNameAr : serviceNameEn;
}

/// A new booking request (`POST /bookings`). [locationFields] are the place fields exactly as the location picker produces them
/// (`addressLine`, `district`, `building`, `locationNotes`, `latitude`, `longitude`); nothing else is accepted for the place, and the
/// customer is always the signed-in user (never sent).
class CreateBookingRequest {
  const CreateBookingRequest({
    required this.serviceId,
    required this.cityId,
    required this.problemDescription,
    required this.preferredStartAt,
    required this.preferredEndAt,
    required this.locationFields,
    this.isUrgent = false,
  });

  final String serviceId;
  final String cityId;
  final String problemDescription;
  final DateTime preferredStartAt;
  final DateTime preferredEndAt;
  final bool isUrgent;
  final Map<String, Object> locationFields;

  static const _locationKeys = {'addressLine', 'district', 'building', 'locationNotes', 'latitude', 'longitude'};

  Map<String, Object?> toJson() {
    final unknown = locationFields.keys.where((k) => !_locationKeys.contains(k));
    if (unknown.isNotEmpty) throw ArgumentError('Not booking location fields: ${unknown.join(', ')}');
    return {
      'serviceId': serviceId,
      'cityId': cityId,
      'problemDescription': problemDescription,
      'isUrgent': isUrgent,
      'preferredStartAt': preferredStartAt.toUtc().toIso8601String(),
      'preferredEndAt': preferredEndAt.toUtc().toIso8601String(),
      ...locationFields,
    };
  }
}
