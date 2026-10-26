/// What an approved worker sees of bookings: open requests they can quote on, their quotes, and the jobs assigned to them. Mirrors the
/// backend's `WorkerRequestSummaryDto`, `WorkerRequestDetailDto`, `QuoteForWorkerDto` and `WorkerBookingDto`.
///
/// Privacy is the backend's job and these classes only carry what it sent: a request (and a booking that is not yet paid) holds the city and
/// district only; the street, building, notes, exact point and the customer's name and phone arrive once the customer has paid. A field that
/// is absent stays null and is never replaced by a default.
library;

import 'booking_models.dart';

/// One page of a list endpoint (`{ items, meta }`).
class PagedList<T> {
  const PagedList({required this.items, required this.page, required this.total, required this.totalPages});

  factory PagedList.fromJson(Map<String, dynamic> json, T Function(Map<String, dynamic>) parse) {
    final meta = json['meta'] as Map<String, dynamic>? ?? const {};
    final items = [for (final i in (json['items'] as List<dynamic>? ?? const [])) parse(i as Map<String, dynamic>)];
    return PagedList(
      items: items,
      page: (meta['page'] as num?)?.toInt() ?? 1,
      total: (meta['total'] as num?)?.toInt() ?? items.length,
      totalPages: (meta['totalPages'] as num?)?.toInt() ?? 1,
    );
  }

  final List<T> items;
  final int page;
  final int total;
  final int totalPages;

  bool get hasMore => page < totalPages;
}

/// Amounts in halalas (100 = SAR 1). The server computes every figure; the app only shows them.
class WorkerMoney {
  const WorkerMoney({
    required this.currency,
    required this.serviceHalalas,
    required this.vatHalalas,
    required this.totalHalalas,
    required this.vatRateBps,
    required this.commissionHalalas,
    required this.payoutHalalas,
    required this.commissionRateBps,
  });

  factory WorkerMoney.fromJson(Map<String, dynamic> json) => WorkerMoney(
    currency: json['currency'] as String? ?? 'SAR',
    serviceHalalas: _int(json['serviceHalalas']),
    vatHalalas: _int(json['vatHalalas']),
    totalHalalas: _int(json['totalHalalas']),
    vatRateBps: _int(json['vatRateBps']),
    commissionHalalas: _int(json['commissionHalalas']),
    payoutHalalas: _int(json['payoutHalalas']),
    commissionRateBps: _int(json['commissionRateBps']),
  );

  final String currency;

  /// The worker's own price, before VAT.
  final int serviceHalalas;
  final int vatHalalas;

  /// What the customer pays.
  final int totalHalalas;
  final int vatRateBps;

  /// Platform commission, deducted from the worker's price.
  final int commissionHalalas;

  /// What the worker receives.
  final int payoutHalalas;
  final int commissionRateBps;

  double get service => serviceHalalas / 100;
  double get total => totalHalalas / 100;
  double get payout => payoutHalalas / 100;
  double get commission => commissionHalalas / 100;
}

class JobService {
  const JobService({required this.id, required this.nameEn, required this.nameAr, this.slug = ''});

  factory JobService.fromJson(Map<String, dynamic> json) => JobService(
    id: json['id'] as String? ?? '',
    slug: json['slug'] as String? ?? '',
    nameEn: json['nameEn'] as String? ?? '',
    nameAr: json['nameAr'] as String? ?? '',
  );

  final String id;
  final String slug;
  final String nameEn;
  final String nameAr;

  String name({required bool arabic}) => arabic && nameAr.isNotEmpty ? nameAr : nameEn;
}

class WorkerQuote {
  const WorkerQuote({
    required this.id,
    required this.bookingId,
    required this.bookingReference,
    required this.status,
    required this.version,
    required this.money,
    required this.proposedStartAt,
    required this.proposedEndAt,
    required this.validUntil,
    required this.isExpired,
    this.estimatedDurationMinutes,
    this.message,
    this.createdAt,
  });

  factory WorkerQuote.fromJson(Map<String, dynamic> json) => WorkerQuote(
    id: json['id'] as String,
    bookingId: json['bookingId'] as String? ?? '',
    bookingReference: json['bookingReference'] as String? ?? '',
    status: json['status'] as String? ?? '',
    version: _int(json['version']),
    money: WorkerMoney.fromJson(json['money'] as Map<String, dynamic>? ?? const {}),
    proposedStartAt: _date(json['proposedStartAt']),
    proposedEndAt: _date(json['proposedEndAt']),
    estimatedDurationMinutes: (json['estimatedDurationMinutes'] as num?)?.toInt(),
    message: json['message'] as String?,
    validUntil: _date(json['validUntil']),
    isExpired: json['isExpired'] as bool? ?? false,
    createdAt: _date(json['createdAt']),
  );

  final String id;
  final String bookingId;
  final String bookingReference;

  /// SUBMITTED, ACCEPTED, REJECTED, WITHDRAWN, EXPIRED ... (the backend's quote states).
  final String status;
  final int version;
  final WorkerMoney money;
  final DateTime? proposedStartAt;
  final DateTime? proposedEndAt;
  final int? estimatedDurationMinutes;
  final String? message;
  final DateTime? validUntil;
  final bool isExpired;
  final DateTime? createdAt;

  /// Still open to the customer: submitted and not past its validity.
  bool get isLive => status == 'SUBMITTED' && !isExpired;
}

/// An open request (or, with [problemDescription], its detail). The place is the city and district only.
class WorkerRequest {
  const WorkerRequest({
    required this.id,
    required this.reference,
    required this.status,
    required this.service,
    required this.location,
    required this.isUrgent,
    this.preferredStartAt,
    this.preferredEndAt,
    this.expiresAt,
    this.myQuote,
    this.createdAt,
    this.problemDescription,
    this.photoCount = 0,
  });

  factory WorkerRequest.fromJson(Map<String, dynamic> json) => WorkerRequest(
    id: json['id'] as String,
    reference: json['reference'] as String? ?? '',
    status: json['status'] as String? ?? '',
    service: JobService.fromJson(json['service'] as Map<String, dynamic>? ?? const {}),
    location: BookingLocation.fromJson(json['location'] as Map<String, dynamic>? ?? const {}),
    isUrgent: json['isUrgent'] as bool? ?? false,
    preferredStartAt: _date(json['preferredStartAt']),
    preferredEndAt: _date(json['preferredEndAt']),
    expiresAt: _date(json['expiresAt']),
    myQuote: json['myQuote'] is Map<String, dynamic> ? WorkerQuote.fromJson(json['myQuote'] as Map<String, dynamic>) : null,
    createdAt: _date(json['createdAt']),
    problemDescription: json['problemDescription'] as String?,
    photoCount: (json['photos'] as List<dynamic>?)?.length ?? 0,
  );

  final String id;
  final String reference;
  final String status;
  final JobService service;
  final BookingLocation location;
  final bool isUrgent;
  final DateTime? preferredStartAt;
  final DateTime? preferredEndAt;

  /// When the request lapses if the customer chooses no quote.
  final DateTime? expiresAt;
  final WorkerQuote? myQuote;
  final DateTime? createdAt;
  final String? problemDescription;

  /// Photos the customer attached (only their number is carried; viewing them needs a signed download address).
  final int photoCount;
}

/// A booking assigned to this worker (their quote was accepted). Before the customer pays it is PAYMENT_PENDING and the place is the city
/// and district only; once paid it is CONFIRMED and carries the full address, exact point and the customer's contact.
class WorkerJob extends WorkerRequest {
  const WorkerJob({
    required super.id,
    required super.reference,
    required super.status,
    required super.service,
    required super.location,
    required super.isUrgent,
    super.preferredStartAt,
    super.preferredEndAt,
    super.expiresAt,
    super.myQuote,
    super.createdAt,
    super.problemDescription,
    super.photoCount,
    this.money,
    this.customerName,
    this.customerPhone,
    this.paymentMethod,
    this.cashCollectedAt,
    this.startedAt,
    this.completedAt,
  });

  factory WorkerJob.fromJson(Map<String, dynamic> json) {
    final r = WorkerRequest.fromJson(json);
    return WorkerJob(
      id: r.id,
      reference: r.reference,
      status: r.status,
      service: r.service,
      location: r.location,
      isUrgent: r.isUrgent,
      preferredStartAt: r.preferredStartAt,
      preferredEndAt: r.preferredEndAt,
      expiresAt: r.expiresAt,
      myQuote: r.myQuote,
      createdAt: r.createdAt,
      problemDescription: r.problemDescription,
      photoCount: r.photoCount,
      money: json['money'] is Map<String, dynamic> ? WorkerMoney.fromJson(json['money'] as Map<String, dynamic>) : null,
      customerName: json['customerName'] as String?,
      customerPhone: json['customerPhone'] as String?,
      paymentMethod: json['paymentMethod'] as String?,
      cashCollectedAt: _date(json['cashCollectedAt']),
      startedAt: _date(json['startedAt']),
      completedAt: _date(json['completedAt']),
    );
  }

  final WorkerMoney? money;

  /// Released by the backend only after payment.
  final String? customerName;
  final String? customerPhone;

  /// CASH: the worker collects the agreed total from the customer in person. Null until the customer has chosen.
  final String? paymentMethod;

  /// CASH only: when the worker confirmed receiving the cash.
  final DateTime? cashCollectedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;

  /// The customer has paid when the backend releases their contact; the job can then be started.
  bool get isCash => paymentMethod == 'CASH';

  /// The worker still has to confirm receiving the cash (once the work has started).
  bool get canConfirmCash => isCash && cashCollectedAt == null && (status == 'IN_PROGRESS' || status == 'COMPLETED');

  bool get canStart => status == 'CONFIRMED';
  bool get canComplete => status == 'IN_PROGRESS';
}

/// `POST /workers/me/requests/:bookingId/quote`. The price is the worker's own, before VAT, in halalas; VAT, commission and the total are
/// computed by the server.
class SubmitQuoteRequest {
  const SubmitQuoteRequest({
    required this.priceHalalas,
    required this.proposedStartAt,
    required this.proposedEndAt,
    this.estimatedDurationMinutes,
    this.message,
    this.validForHours,
  });

  final int priceHalalas;
  final DateTime proposedStartAt;
  final DateTime proposedEndAt;
  final int? estimatedDurationMinutes;
  final String? message;
  final int? validForHours;

  Map<String, Object?> toJson() => {
    'priceHalalas': priceHalalas,
    'proposedStartAt': proposedStartAt.toUtc().toIso8601String(),
    'proposedEndAt': proposedEndAt.toUtc().toIso8601String(),
    if (estimatedDurationMinutes != null) 'estimatedDurationMinutes': estimatedDurationMinutes,
    if (message != null && message!.trim().isNotEmpty) 'message': message!.trim(),
    if (validForHours != null) 'validForHours': validForHours,
  };
}

int _int(Object? v) => v is num ? v.toInt() : 0;
DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;
