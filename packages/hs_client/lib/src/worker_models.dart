/// Plain data for the worker onboarding screens. Mirrors the backend's `WorkerOnboardingDto` (`GET /workers/me/onboarding`) and the public
/// catalog (`GET /catalog`, `GET /catalog/cities`). Nothing here is invented client-side: every value comes from a server response.
library;

/// The server-side verification states (`WorkerVerificationStatus`). Unknown values are kept as [unknown] rather than guessed.
enum VerificationState {
  notSubmitted,
  submitted,
  underReview,
  infoRequired,
  approved,
  rejected,
  suspended,
  unknown;

  static VerificationState parse(String? value) => switch (value) {
    'NOT_SUBMITTED' => notSubmitted,
    'SUBMITTED' => submitted,
    'UNDER_REVIEW' => underReview,
    'INFO_REQUIRED' => infoRequired,
    'APPROVED' => approved,
    'REJECTED' => rejected,
    'SUSPENDED' => suspended,
    _ => unknown,
  };

  /// Waiting for a reviewer: nothing for the worker to do.
  bool get isPending => this == submitted || this == underReview;
}

class CatalogService {
  const CatalogService({
    required this.id,
    required this.categoryId,
    required this.nameEn,
    required this.nameAr,
    this.slug = '',
    this.descriptionEn,
    this.descriptionAr,
  });

  factory CatalogService.fromJson(Map<String, dynamic> json) => CatalogService(
    id: json['id'] as String,
    categoryId: json['categoryId'] as String? ?? '',
    nameEn: json['nameEn'] as String? ?? '',
    nameAr: json['nameAr'] as String? ?? '',
    slug: json['slug'] as String? ?? '',
    descriptionEn: json['descriptionEn'] as String?,
    descriptionAr: json['descriptionAr'] as String?,
  );

  final String id;
  final String categoryId;
  final String nameEn;
  final String nameAr;
  final String slug;
  final String? descriptionEn;
  final String? descriptionAr;

  String? description({required bool arabic}) => arabic && (descriptionAr?.isNotEmpty ?? false) ? descriptionAr : descriptionEn;

  String name({required bool arabic}) => arabic && nameAr.isNotEmpty ? nameAr : nameEn;
}

class CatalogCategory {
  const CatalogCategory({required this.id, required this.nameEn, required this.nameAr, required this.services, this.slug = '', this.iconKey});

  factory CatalogCategory.fromJson(Map<String, dynamic> json) => CatalogCategory(
    id: json['id'] as String,
    nameEn: json['nameEn'] as String? ?? '',
    nameAr: json['nameAr'] as String? ?? '',
    slug: json['slug'] as String? ?? '',
    iconKey: json['iconKey'] as String?,
    services: [for (final s in (json['services'] as List<dynamic>? ?? const [])) CatalogService.fromJson(s as Map<String, dynamic>)],
  );

  final String id;
  final String nameEn;
  final String nameAr;
  final String slug;
  final String? iconKey;
  final List<CatalogService> services;

  String name({required bool arabic}) => arabic && nameAr.isNotEmpty ? nameAr : nameEn;
}

class City {
  const City({required this.id, required this.nameEn, required this.nameAr});

  factory City.fromJson(Map<String, dynamic> json) =>
      City(id: json['id'] as String, nameEn: json['nameEn'] as String? ?? '', nameAr: json['nameAr'] as String? ?? '');

  final String id;
  final String nameEn;
  final String nameAr;

  String name({required bool arabic}) => arabic && nameAr.isNotEmpty ? nameAr : nameEn;
}

class Catalog {
  const Catalog({required this.categories, required this.cities});

  final List<CatalogCategory> categories;
  final List<City> cities;
}

class WorkerProfileData {
  const WorkerProfileData({this.fullName, this.fullNameAr, this.bio, this.yearsOfExperience});

  factory WorkerProfileData.fromJson(Map<String, dynamic> json) => WorkerProfileData(
    fullName: json['fullName'] as String?,
    fullNameAr: json['fullNameAr'] as String?,
    bio: json['bio'] as String?,
    yearsOfExperience: (json['yearsOfExperience'] as num?)?.toInt(),
  );

  final String? fullName;
  final String? fullNameAr;
  final String? bio;
  final int? yearsOfExperience;
}

class AvailabilityWindow {
  const AvailabilityWindow({required this.dayOfWeek, required this.startTime, required this.endTime});

  factory AvailabilityWindow.fromJson(Map<String, dynamic> json) =>
      AvailabilityWindow(dayOfWeek: (json['dayOfWeek'] as num).toInt(), startTime: json['startTime'] as String, endTime: json['endTime'] as String);

  /// 0 = Sunday ... 6 = Saturday.
  final int dayOfWeek;

  /// 24-hour `HH:mm`, Saudi local time.
  final String startTime;
  final String endTime;

  Map<String, dynamic> toJson() => {'dayOfWeek': dayOfWeek, 'startTime': startTime, 'endTime': endTime};
}

enum DocumentKind {
  nationalId('NATIONAL_ID'),
  iqama('IQAMA'),
  professionalLicense('PROFESSIONAL_LICENSE'),
  certificate('CERTIFICATE'),
  photo('PHOTO'),
  other('OTHER');

  const DocumentKind(this.wire);
  final String wire;

  static DocumentKind parse(String? value) => DocumentKind.values.firstWhere((k) => k.wire == value, orElse: () => DocumentKind.other);
}

/// A stored verification document (metadata only: the app never downloads documents).
class WorkerDocument {
  const WorkerDocument({
    required this.id,
    required this.kind,
    required this.status,
    required this.fileName,
    required this.scanStatus,
    this.reviewNote,
  });

  factory WorkerDocument.fromJson(Map<String, dynamic> json) => WorkerDocument(
    id: json['id'] as String,
    kind: DocumentKind.parse(json['type'] as String?),
    status: json['status'] as String? ?? 'PENDING_UPLOAD',
    fileName: json['fileName'] as String? ?? '',
    scanStatus: json['scanStatus'] as String? ?? 'NOT_SCANNED',
    reviewNote: json['reviewNote'] as String?,
  );

  final String id;
  final DocumentKind kind;

  /// PENDING_UPLOAD, UPLOADED, ACCEPTED or REJECTED.
  final String status;
  final String fileName;

  /// NOT_SCANNED, PENDING, CLEAN, INFECTED or ERROR. NOT_SCANNED is NOT a statement that the file is safe.
  final String scanStatus;
  final String? reviewNote;

  bool get isUsable => status == 'UPLOADED' || status == 'ACCEPTED';
  bool get isRejected => status == 'REJECTED' || scanStatus == 'INFECTED';
}

class VerificationHistoryItem {
  const VerificationHistoryItem({required this.toStatus, required this.createdAt, this.reason});

  factory VerificationHistoryItem.fromJson(Map<String, dynamic> json) => VerificationHistoryItem(
    toStatus: VerificationState.parse(json['toStatus'] as String?),
    createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    reason: json['reason'] as String?,
  );

  final VerificationState toStatus;
  final DateTime createdAt;
  final String? reason;
}

class VerificationInfo {
  const VerificationInfo({
    required this.state,
    required this.rawStatus,
    required this.canSubmit,
    this.note,
    this.submittedAt,
    this.verifiedAt,
    this.missing = const [],
    this.history = const [],
  });

  factory VerificationInfo.fromJson(Map<String, dynamic> json) => VerificationInfo(
    state: VerificationState.parse(json['status'] as String?),
    rawStatus: json['status'] as String? ?? '',
    note: json['note'] as String?,
    submittedAt: DateTime.tryParse(json['submittedAt'] as String? ?? ''),
    verifiedAt: DateTime.tryParse(json['verifiedAt'] as String? ?? ''),
    canSubmit: json['canSubmit'] as bool? ?? false,
    missing: [for (final m in (json['missing'] as List<dynamic>? ?? const [])) m as String],
    history: [for (final h in (json['history'] as List<dynamic>? ?? const [])) VerificationHistoryItem.fromJson(h as Map<String, dynamic>)],
  );

  final VerificationState state;

  /// The status exactly as the server sent it (kept for the user record).
  final String rawStatus;

  /// Latest reviewer message.
  final String? note;
  final DateTime? submittedAt;
  final DateTime? verifiedAt;

  /// True when the server accepts a submission (or resubmission) right now.
  final bool canSubmit;

  /// FULL_NAME, YEARS_OF_EXPERIENCE, SERVICES, SERVICE_AREAS, AVAILABILITY or IDENTITY_DOCUMENT.
  final List<String> missing;
  final List<VerificationHistoryItem> history;
}

class WorkerOnboarding {
  const WorkerOnboarding({
    required this.profile,
    required this.serviceIds,
    required this.cityIds,
    required this.availability,
    required this.documents,
    required this.verification,
  });

  factory WorkerOnboarding.fromJson(Map<String, dynamic> json) => WorkerOnboarding(
    profile: WorkerProfileData.fromJson(json['profile'] as Map<String, dynamic>? ?? const {}),
    serviceIds: {for (final s in (json['services'] as List<dynamic>? ?? const [])) (s as Map<String, dynamic>)['id'] as String},
    cityIds: {for (final c in (json['cities'] as List<dynamic>? ?? const [])) (c as Map<String, dynamic>)['id'] as String},
    availability: [for (final a in (json['availability'] as List<dynamic>? ?? const [])) AvailabilityWindow.fromJson(a as Map<String, dynamic>)],
    documents: [for (final d in (json['documents'] as List<dynamic>? ?? const [])) WorkerDocument.fromJson(d as Map<String, dynamic>)],
    verification: VerificationInfo.fromJson(json['verification'] as Map<String, dynamic>? ?? const {}),
  );

  final WorkerProfileData profile;
  final Set<String> serviceIds;
  final Set<String> cityIds;
  final List<AvailabilityWindow> availability;
  final List<WorkerDocument> documents;
  final VerificationInfo verification;
}

/// What `POST /workers/me/documents` answers: the stored metadata and where to PUT the bytes.
class DocumentUploadTicket {
  const DocumentUploadTicket({required this.document, required this.uploadUrl, required this.headers, required this.expiresAt});

  factory DocumentUploadTicket.fromJson(Map<String, dynamic> json) => DocumentUploadTicket(
    document: WorkerDocument.fromJson(json['document'] as Map<String, dynamic>),
    uploadUrl: json['uploadUrl'] as String,
    headers: {for (final e in (json['headers'] as Map<String, dynamic>? ?? const {}).entries) e.key: '${e.value}'},
    expiresAt: DateTime.tryParse(json['expiresAt'] as String? ?? ''),
  );

  final WorkerDocument document;

  /// A short-lived signed address. Treat it like a secret: never log it.
  final String uploadUrl;
  final Map<String, String> headers;
  final DateTime? expiresAt;
}
