/// What the customer sees while choosing a worker and paying: quotes, the booking in detail, and payment attempts. Mirrors the backend's
/// `QuoteForCustomerDto`, `BookingDetailDto` and `PaymentAttemptDto`. Amounts are halalas (100 = SAR 1); the server computes every one.
library;

import 'booking_models.dart';

class CustomerMoney {
  const CustomerMoney({
    required this.currency,
    required this.serviceHalalas,
    required this.vatHalalas,
    required this.totalHalalas,
    required this.vatRateBps,
  });

  factory CustomerMoney.fromJson(Map<String, dynamic> json) => CustomerMoney(
    currency: json['currency'] as String? ?? 'SAR',
    serviceHalalas: _int(json['serviceHalalas']),
    vatHalalas: _int(json['vatHalalas']),
    totalHalalas: _int(json['totalHalalas']),
    vatRateBps: _int(json['vatRateBps']),
  );

  final String currency;
  final int serviceHalalas;
  final int vatHalalas;

  /// What the customer pays.
  final int totalHalalas;
  final int vatRateBps;

  double get service => serviceHalalas / 100;
  double get vat => vatHalalas / 100;
  double get total => totalHalalas / 100;
}

/// The worker behind a quote, as customers may see them. Ratings do not exist yet (always null / 0).
class QuoteWorker {
  const QuoteWorker({
    required this.workerId,
    this.fullName,
    this.fullNameAr,
    this.bio,
    this.yearsOfExperience,
    this.serviceYearsOfExperience,
    this.ratingAverage,
    this.ratingCount = 0,
  });

  factory QuoteWorker.fromJson(Map<String, dynamic> json) => QuoteWorker(
    workerId: json['workerId'] as String? ?? '',
    fullName: json['fullName'] as String?,
    fullNameAr: json['fullNameAr'] as String?,
    bio: json['bio'] as String?,
    yearsOfExperience: (json['yearsOfExperience'] as num?)?.toInt(),
    serviceYearsOfExperience: (json['serviceYearsOfExperience'] as num?)?.toInt(),
    ratingAverage: (json['ratingAverage'] as num?)?.toDouble(),
    ratingCount: _int(json['ratingCount']),
  );

  final String workerId;
  final String? fullName;
  final String? fullNameAr;
  final String? bio;
  final int? yearsOfExperience;
  final int? serviceYearsOfExperience;
  final double? ratingAverage;
  final int ratingCount;

  String name({required bool arabic}) {
    final ar = fullNameAr;
    final en = fullName;
    if (arabic && ar != null && ar.isNotEmpty) return ar;
    return (en != null && en.isNotEmpty) ? en : (ar ?? '');
  }
}

class CustomerQuote {
  const CustomerQuote({
    required this.id,
    required this.bookingId,
    required this.status,
    required this.version,
    required this.money,
    required this.worker,
    required this.isExpired,
    this.proposedStartAt,
    this.proposedEndAt,
    this.estimatedDurationMinutes,
    this.message,
    this.validUntil,
    this.changeRequest,
  });

  factory CustomerQuote.fromJson(Map<String, dynamic> json) => CustomerQuote(
    id: json['id'] as String,
    bookingId: json['bookingId'] as String? ?? '',
    status: json['status'] as String? ?? '',
    version: _int(json['version']),
    money: CustomerMoney.fromJson(json['money'] as Map<String, dynamic>? ?? const {}),
    worker: QuoteWorker.fromJson(json['worker'] as Map<String, dynamic>? ?? const {}),
    isExpired: json['isExpired'] as bool? ?? false,
    proposedStartAt: _date(json['proposedStartAt']),
    proposedEndAt: _date(json['proposedEndAt']),
    estimatedDurationMinutes: (json['estimatedDurationMinutes'] as num?)?.toInt(),
    message: json['message'] as String?,
    validUntil: _date(json['validUntil']),
    changeRequest: json['changeRequest'] as String?,
  );

  final String id;
  final String bookingId;
  final String status;

  /// Sent back when accepting, so a quote the worker changed meanwhile is refused (409 QUOTE_CHANGED) instead of accepted at a new price.
  final int version;
  final CustomerMoney money;
  final QuoteWorker worker;
  final bool isExpired;
  final DateTime? proposedStartAt;
  final DateTime? proposedEndAt;
  final int? estimatedDurationMinutes;
  final String? message;
  final DateTime? validUntil;

  /// What the customer asked this worker to change, until the worker edits the quote.
  final String? changeRequest;

  bool get canAccept => status == 'SUBMITTED' && !isExpired;
}

class AssignedWorker {
  const AssignedWorker({required this.workerId, this.fullName, this.fullNameAr, this.phone});

  factory AssignedWorker.fromJson(Map<String, dynamic> json) => AssignedWorker(
    workerId: json['workerId'] as String? ?? '',
    fullName: json['fullName'] as String?,
    fullNameAr: json['fullNameAr'] as String?,
    phone: json['phone'] as String?,
  );

  final String workerId;
  final String? fullName;
  final String? fullNameAr;

  /// Shared only once the booking is paid.
  final String? phone;

  String name({required bool arabic}) {
    if (arabic && fullNameAr != null && fullNameAr!.isNotEmpty) return fullNameAr!;
    return (fullName != null && fullName!.isNotEmpty) ? fullName! : (fullNameAr ?? '');
  }
}

/// One booking in full, for its owner.
class BookingDetail {
  const BookingDetail({
    required this.id,
    required this.reference,
    required this.status,
    required this.serviceNameEn,
    required this.serviceNameAr,
    required this.location,
    required this.isUrgent,
    required this.problemDescription,
    this.preferredStartAt,
    this.preferredEndAt,
    this.expiresAt,
    this.money,
    this.worker,
    this.acceptedQuoteId,
    this.paymentDueAt,
    this.paymentMethod,
    this.quoteCount = 0,
    this.arrivedAt,
    this.timeline = const [],
  });

  factory BookingDetail.fromJson(Map<String, dynamic> json) {
    final service = json['service'] as Map<String, dynamic>? ?? const {};
    return BookingDetail(
      id: json['id'] as String,
      reference: json['reference'] as String? ?? '',
      status: json['status'] as String? ?? '',
      serviceNameEn: service['nameEn'] as String? ?? '',
      serviceNameAr: service['nameAr'] as String? ?? '',
      location: BookingLocation.fromJson(json['location'] as Map<String, dynamic>? ?? const {}),
      isUrgent: json['isUrgent'] as bool? ?? false,
      problemDescription: json['problemDescription'] as String? ?? '',
      preferredStartAt: _date(json['preferredStartAt']),
      preferredEndAt: _date(json['preferredEndAt']),
      expiresAt: _date(json['expiresAt']),
      money: json['money'] is Map<String, dynamic> ? CustomerMoney.fromJson(json['money'] as Map<String, dynamic>) : null,
      worker: json['worker'] is Map<String, dynamic> ? AssignedWorker.fromJson(json['worker'] as Map<String, dynamic>) : null,
      acceptedQuoteId: json['acceptedQuoteId'] as String?,
      paymentDueAt: _date(json['paymentDueAt']),
      paymentMethod: json['paymentMethod'] as String?,
      quoteCount: _int(json['quoteCount']),
      arrivedAt: _date(json['arrivedAt']),
      timeline: [for (final e in (json['timeline'] as List<dynamic>? ?? const [])) BookingEvent.fromJson(e as Map<String, dynamic>)],
    );
  }

  final String id;
  final String reference;

  /// OPEN, PAYMENT_PENDING, CONFIRMED, IN_PROGRESS, COMPLETED, CANCELLED, EXPIRED.
  final String status;
  final String serviceNameEn;
  final String serviceNameAr;
  final BookingLocation location;
  final bool isUrgent;
  final String problemDescription;
  final DateTime? preferredStartAt;
  final DateTime? preferredEndAt;
  final DateTime? expiresAt;

  /// Set once a quote was accepted.
  final CustomerMoney? money;
  final AssignedWorker? worker;
  final String? acceptedQuoteId;
  final DateTime? paymentDueAt;

  /// ONLINE, or CASH (the customer pays the worker in person). Null until chosen.
  final String? paymentMethod;
  final int quoteCount;

  /// When the worker said they had arrived (a paid booking, before the work starts).
  final DateTime? arrivedAt;

  /// What happened to the booking and when, oldest first.
  final List<BookingEvent> timeline;

  /// The time of the first event of [type] (for example WORK_STARTED), or null.
  DateTime? when(String type) {
    for (final e in timeline) {
      if (e.type == type) return e.createdAt;
    }
    return null;
  }

  bool get isCash => paymentMethod == 'CASH';

  String serviceName({required bool arabic}) => arabic && serviceNameAr.isNotEmpty ? serviceNameAr : serviceNameEn;
}

/// One entry of a booking's history (`BookingEventDto`): QUOTE_ACCEPTED, PAYMENT_CONFIRMED, WORK_STARTED ...
class BookingEvent {
  const BookingEvent({required this.type, this.createdAt});

  factory BookingEvent.fromJson(Map<String, dynamic> json) => BookingEvent(type: json['type'] as String? ?? '', createdAt: _date(json['createdAt']));

  final String type;
  final DateTime? createdAt;
}

/// Where to PUT one problem photo (`PhotoUploadDto`). The address is a short-lived secret: never log it.
class PhotoUploadTicket {
  const PhotoUploadTicket({required this.photoId, required this.uploadUrl, required this.headers});

  factory PhotoUploadTicket.fromJson(Map<String, dynamic> json) => PhotoUploadTicket(
    photoId: (json['photo'] as Map<String, dynamic>? ?? const {})['id'] as String? ?? '',
    uploadUrl: json['uploadUrl'] as String? ?? '',
    headers: {for (final e in (json['headers'] as Map<String, dynamic>? ?? const {}).entries) e.key: '${e.value}'},
  );

  final String photoId;
  final String uploadUrl;
  final Map<String, String> headers;
}

/// One attempt to pay (`PaymentAttemptDto`). The booking only becomes CONFIRMED when the server has a verified provider event: this object
/// being returned, or the customer coming back from a checkout page, proves nothing.
class PaymentAttempt {
  const PaymentAttempt({
    required this.id,
    required this.bookingId,
    required this.status,
    required this.amountHalalas,
    required this.currency,
    required this.simulated,
    this.checkoutUrl,
    this.checkoutExpiresAt,
    this.failureCode,
    this.failureMessage,
  });

  factory PaymentAttempt.fromJson(Map<String, dynamic> json) {
    final checkout = json['checkout'] as Map<String, dynamic>?;
    final failure = json['failure'] as Map<String, dynamic>?;
    return PaymentAttempt(
      id: json['id'] as String,
      bookingId: json['bookingId'] as String? ?? '',
      status: json['status'] as String? ?? '',
      amountHalalas: _int(json['amountHalalas']),
      currency: json['currency'] as String? ?? 'SAR',
      simulated: json['simulated'] as bool? ?? false,
      checkoutUrl: checkout?['url'] as String?,
      checkoutExpiresAt: _date(checkout?['expiresAt']),
      failureCode: failure?['code'] as String?,
      failureMessage: failure?['message'] as String?,
    );
  }

  final String id;
  final String bookingId;

  /// INITIATED, PROCESSING, SUCCEEDED, CAPTURED_UNAPPLIED, FAILED, CANCELLED, EXPIRED.
  final String status;
  final int amountHalalas;
  final String currency;

  /// Created by the development mock provider: no money moves.
  final bool simulated;
  final String? checkoutUrl;
  final DateTime? checkoutExpiresAt;
  final String? failureCode;
  final String? failureMessage;

  bool get isOpen => status == 'INITIATED' || status == 'PROCESSING';
}

/// The assigned worker's last shared position, as the booking's customer may read it (`GET /bookings/:id/location`).
///
/// The server never invents a position: [available] is false while sharing is not open ([LiveLocationReason.notActive]) or while the worker
/// has not reported recently ([LiveLocationReason.noRecentPosition]).
enum LiveLocationReason { notActive, noRecentPosition, unknown }

class LiveLocation {
  const LiveLocation.unavailable(this.reason)
    : available = false,
      latitude = null,
      longitude = null,
      accuracyMeters = null,
      headingDegrees = null,
      recordedAt = null,
      ageSeconds = null;

  const LiveLocation.at({
    required double this.latitude,
    required double this.longitude,
    this.accuracyMeters,
    this.headingDegrees,
    this.recordedAt,
    this.ageSeconds,
  }) : available = true,
       reason = null;

  factory LiveLocation.fromJson(Map<String, dynamic> json) {
    if (json['available'] != true) {
      return LiveLocation.unavailable(switch (json['reason']) {
        'SHARING_NOT_ACTIVE' => LiveLocationReason.notActive,
        'NO_RECENT_POSITION' => LiveLocationReason.noRecentPosition,
        _ => LiveLocationReason.unknown,
      });
    }
    final raw = json['location'];
    final l = raw is Map<String, dynamic> ? raw : const <String, dynamic>{};
    final lat = l['latitude'] is num ? (l['latitude'] as num).toDouble() : null;
    final lng = l['longitude'] is num ? (l['longitude'] as num).toDouble() : null;
    // a position without usable coordinates is "no position", never a pin at 0,0
    if (lat == null || lng == null || !lat.isFinite || !lng.isFinite || lat.abs() > 90 || lng.abs() > 180 || (lat == 0 && lng == 0)) {
      return const LiveLocation.unavailable(LiveLocationReason.noRecentPosition);
    }
    return LiveLocation.at(
      latitude: lat,
      longitude: lng,
      accuracyMeters: (l['accuracyMeters'] as num?)?.toDouble(),
      headingDegrees: (l['headingDegrees'] as num?)?.toDouble(),
      recordedAt: DateTime.tryParse(l['recordedAt'] as String? ?? ''),
      ageSeconds: (json['ageSeconds'] as num?)?.toInt(),
    );
  }

  final bool available;
  final LiveLocationReason? reason;
  final double? latitude;
  final double? longitude;
  final double? accuracyMeters;
  final double? headingDegrees;
  final DateTime? recordedAt;
  final int? ageSeconds;
}

int _int(Object? v) => v is num ? v.toInt() : 0;
DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;
