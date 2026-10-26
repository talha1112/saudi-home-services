/// A service location the customer confirmed on the map. Coordinates are WGS84 degrees.
///
/// [toBookingFields] maps it onto the backend's existing booking location fields (`addressLine`, `district`, `building`, `locationNotes`,
/// `latitude`, `longitude`); nothing here needs a backend change. [label] ("Home", "Office"...) is kept on the phone only: the backend has no
/// saved-address table yet.
class PickedLocation {
  const PickedLocation({
    required this.latitude,
    required this.longitude,
    required this.address,
    this.placeId,
    this.district,
    this.city,
    this.building,
    this.unit,
    this.floor,
    this.label,
    this.notes,
  });

  final double latitude;
  final double longitude;

  /// Readable street address, shown to the customer and sent as `addressLine`. Editable by the customer.
  final String address;
  final String? placeId;

  /// Neighbourhood (for example "Al Olaya"); the backend shows workers only this and the city until a booking is confirmed.
  final String? district;

  /// Locality name as Google reports it. NOT matched against the supported service areas: the booking's city is chosen separately.
  final String? city;
  final String? building;
  final String? unit;
  final String? floor;
  final String? label;
  final String? notes;

  PickedLocation copyWith({
    double? latitude,
    double? longitude,
    String? address,
    String? placeId,
    String? district,
    String? city,
    String? building,
    String? unit,
    String? floor,
    String? label,
    String? notes,
  }) => PickedLocation(
    latitude: latitude ?? this.latitude,
    longitude: longitude ?? this.longitude,
    address: address ?? this.address,
    placeId: placeId ?? this.placeId,
    district: district ?? this.district,
    city: city ?? this.city,
    building: building ?? this.building,
    unit: unit ?? this.unit,
    floor: floor ?? this.floor,
    label: label ?? this.label,
    notes: notes ?? this.notes,
  );

  /// "Bldg 12, Unit 4, Floor 2" style text for the backend's single `building` field (max 120 characters).
  String? get buildingLine {
    final parts = <String>[
      if (_has(building)) building!.trim(),
      if (_has(unit)) 'Unit ${unit!.trim()}',
      if (_has(floor)) 'Floor ${floor!.trim()}',
    ];
    if (parts.isEmpty) return null;
    final joined = parts.join(', ');
    return joined.length <= 120 ? joined : joined.substring(0, 120);
  }

  /// The fields of `POST /bookings` that describe the place. Lengths follow the backend's validation.
  Map<String, Object> toBookingFields() => {
    'addressLine': address.trim().length > 255
        ? address.trim().substring(0, 255)
        : address.trim(),
    if (_has(district))
      'district': district!.trim().length > 120
          ? district!.trim().substring(0, 120)
          : district!.trim(),
    'building': ?buildingLine,
    if (_has(notes))
      'locationNotes': notes!.trim().length > 500
          ? notes!.trim().substring(0, 500)
          : notes!.trim(),
    'latitude': latitude,
    'longitude': longitude,
  };

  static bool _has(String? v) => v != null && v.trim().isNotEmpty;

  /// Valid, finite coordinates inside the world range.
  static bool validCoordinates(double lat, double lng) =>
      lat.isFinite &&
      lng.isFinite &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180;
}
