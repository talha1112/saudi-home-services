/// Why a sign-in step failed, in terms an app can turn into a message. The apps map each value to localized text; nothing here is
/// shown to the user directly and nothing here ever contains a token, code or phone number.
enum AuthIssue {
  invalidPhone,
  invalidCode,
  codeExpired,
  tooManyRequests,
  network,
  unavailable,
  accountSuspended,
  accountDeactivated,

  /// The number belongs to an account that needs a manual check by support (ownership is ambiguous).
  accountNeedsReview,

  /// The number belongs to an account that cannot sign in with a phone number (an administrator).
  notEligible,

  /// Firebase or the server could not verify the sign-in; start again.
  verificationFailed,

  /// Firebase refused this app build (missing signing fingerprint, app not registered): a setup problem, not the user's.
  appNotAuthorized,
  generic,
}

/// The backend answered with an error, or could not be reached ([status] 0). Never includes tokens or request bodies.
class ApiException implements Exception {
  const ApiException({required this.status, required this.code, this.message, this.retryAfterSeconds, this.details, this.fieldMessages = const []});

  final int status;
  final String code;
  final String? message;
  final int? retryAfterSeconds;

  /// The backend's structured details (for example `missing` on VERIFICATION_INCOMPLETE). Never contains tokens.
  final Map<String, dynamic>? details;

  /// Validation messages when the backend rejected the request body field by field (HTTP 400).
  final List<String> fieldMessages;

  bool get isNetwork => status == 0;

  /// 401 on an authenticated call: the access token is missing, expired or revoked.
  bool get isUnauthorized => status == 401;

  AuthIssue get issue {
    if (isNetwork) return AuthIssue.network;
    switch (code) {
      case 'FIREBASE_TOKEN_EXPIRED':
      case 'FIREBASE_TOKEN_STALE':
        return AuthIssue.codeExpired;
      case 'FIREBASE_TOKEN_INVALID':
      case 'FIREBASE_TOKEN_REPLAYED':
      case 'FIREBASE_PHONE_MISSING':
      case 'FIREBASE_PHONE_INVALID':
      case 'FIREBASE_PROVIDER_NOT_ALLOWED':
        return AuthIssue.verificationFailed;
      case 'ACCOUNT_SUSPENDED':
        return AuthIssue.accountSuspended;
      case 'ACCOUNT_DEACTIVATED':
        return AuthIssue.accountDeactivated;
      case 'ACCOUNT_NOT_ELIGIBLE':
        return AuthIssue.notEligible;
      case 'ACCOUNT_LINK_REVIEW_REQUIRED':
      case 'FIREBASE_IDENTITY_CONFLICT':
        return AuthIssue.accountNeedsReview;
      case 'FIREBASE_AUTH_NOT_CONFIGURED':
      case 'FIREBASE_UNAVAILABLE':
        return AuthIssue.unavailable;
    }
    if (status == 429) return AuthIssue.tooManyRequests;
    if (status == 503) return AuthIssue.unavailable;
    return AuthIssue.generic;
  }

  @override
  String toString() => 'ApiException($status $code)';
}

/// Firebase could not send or confirm the SMS code.
class PhoneAuthFailure implements Exception {
  const PhoneAuthFailure(this.issue);

  final AuthIssue issue;

  @override
  String toString() => 'PhoneAuthFailure($issue)';
}
