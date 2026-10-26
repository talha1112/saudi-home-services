/// Which app is signing in. The value is sent to the backend as `app`; there is deliberately no administrator.
enum AppKind { customer, worker }

class HsConfig {
  const HsConfig({required this.baseUrl, required this.kind, this.allowCleartextUploads = false});

  /// Development only: accept a plain-http signed upload address (local development storage). Release builds leave this false.
  final bool allowCleartextUploads;

  /// API root including the version, for example `https://api.example.com/api/v1` (no trailing slash needed).
  final String baseUrl;
  final AppKind kind;
}

class AuthUser {
  const AuthUser({
    required this.id,
    required this.phone,
    required this.fullName,
    required this.status,
    required this.roles,
    required this.activeRole,
    required this.workerVerificationStatus,
  });

  factory AuthUser.fromJson(Map<String, dynamic> json) => AuthUser(
    id: json['id'] as String,
    phone: json['phone'] as String?,
    fullName: json['fullName'] as String?,
    status: json['status'] as String? ?? 'ACTIVE',
    roles: [for (final r in (json['roles'] as List<dynamic>? ?? const [])) r as String],
    activeRole: json['activeRole'] as String? ?? '',
    workerVerificationStatus: json['workerVerificationStatus'] as String?,
  );

  /// The same person with a different saved name.
  AuthUser withName(String? name) => AuthUser(
    id: id,
    phone: phone,
    fullName: name,
    status: status,
    roles: roles,
    activeRole: activeRole,
    workerVerificationStatus: workerVerificationStatus,
  );

  final String id;
  final String? phone;
  final String? fullName;
  final String status;
  final List<String> roles;
  final String activeRole;

  AuthUser withWorkerStatus(String? status) =>
      AuthUser(id: id, phone: phone, fullName: fullName, status: this.status, roles: roles, activeRole: activeRole, workerVerificationStatus: status);

  /// NOT_SUBMITTED, SUBMITTED, UNDER_REVIEW, NEEDS_CHANGES, APPROVED, REJECTED, SUSPENDED... (workers only).
  final String? workerVerificationStatus;

  bool get isApprovedWorker => workerVerificationStatus == 'APPROVED';

  Map<String, dynamic> toJson() => {
    'id': id,
    'phone': phone,
    'fullName': fullName,
    'status': status,
    'roles': roles,
    'activeRole': activeRole,
    'workerVerificationStatus': workerVerificationStatus,
  };
}

/// A signed-in session. Only the refresh token and the user are persisted; the access token lives in memory.
class Session {
  const Session({
    required this.accessToken,
    required this.accessExpiresAt,
    required this.refreshToken,
    required this.refreshExpiresAt,
    required this.user,
    this.isNewUser = false,
  });

  /// Reads the backend's session response. [now] is when the response was received.
  factory Session.fromApi(Map<String, dynamic> json, DateTime now) => Session(
    accessToken: json['accessToken'] as String,
    accessExpiresAt: now.add(Duration(seconds: (json['accessTokenExpiresInSeconds'] as num).toInt())),
    refreshToken: json['refreshToken'] as String,
    refreshExpiresAt: DateTime.parse(json['refreshTokenExpiresAt'] as String),
    user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
    isNewUser: json['isNewUser'] as bool? ?? false,
  );

  /// Restores a session from storage. It has no usable access token, so the first call refreshes.
  factory Session.fromStored(Map<String, dynamic> json) => Session(
    accessToken: '',
    accessExpiresAt: DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    refreshToken: json['refreshToken'] as String,
    refreshExpiresAt: DateTime.parse(json['refreshExpiresAt'] as String),
    user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
  );

  final String accessToken;
  final DateTime accessExpiresAt;
  final String refreshToken;
  final DateTime refreshExpiresAt;
  final AuthUser user;
  final bool isNewUser;

  Map<String, dynamic> toStored() => {
    'refreshToken': refreshToken,
    'refreshExpiresAt': refreshExpiresAt.toUtc().toIso8601String(),
    'user': user.toJson(),
  };

  /// The same session with a different user record (after `/auth/me`).
  Session withUser(AuthUser next) =>
      Session(accessToken: accessToken, accessExpiresAt: accessExpiresAt, refreshToken: refreshToken, refreshExpiresAt: refreshExpiresAt, user: next);
}
