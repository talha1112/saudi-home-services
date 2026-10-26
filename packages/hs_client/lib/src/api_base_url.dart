/// A build was configured with an unusable API address. Thrown at start-up so a misconfigured build fails loudly instead of quietly talking
/// to the wrong server.
class ApiConfigError extends Error {
  ApiConfigError(this.message);

  final String message;

  @override
  String toString() => 'ApiConfigError: $message';
}

/// Decides which backend a build talks to.
///
/// * Debug builds: [raw] if given (HTTP allowed), otherwise [debugDefault] (the Android emulator's alias for the development computer).
/// * Any other build (release, profile): [raw] is REQUIRED and must be an `https` address of a real host. There is no fallback, so a release
///   build can never silently point at the emulator host.
String resolveApiBaseUrl(String raw, {required bool isDebug, String debugDefault = 'http://10.0.2.2:3001/api/v1'}) {
  final value = raw.trim();
  if (value.isEmpty) {
    if (isDebug) return debugDefault;
    throw ApiConfigError('API_BASE_URL is required for release builds. Build with --dart-define=API_BASE_URL=https://<your-api-host>/api/v1');
  }
  final uri = Uri.tryParse(value);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) throw ApiConfigError('API_BASE_URL is not a valid absolute URL');
  if (uri.scheme != 'http' && uri.scheme != 'https') throw ApiConfigError('API_BASE_URL must use https');
  if (uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment) {
    throw ApiConfigError('API_BASE_URL must not contain credentials, a query or a fragment');
  }
  if (!isDebug) {
    if (uri.scheme != 'https') throw ApiConfigError('API_BASE_URL must use https in release builds');
    if (_isLocalHost(uri.host)) throw ApiConfigError('API_BASE_URL must not point at a local or emulator address in release builds');
  }
  return value.endsWith('/') ? value.substring(0, value.length - 1) : value;
}

bool _isLocalHost(String host) {
  final h = host.toLowerCase();
  return h == 'localhost' ||
      h.endsWith('.localhost') ||
      h == '10.0.2.2' ||
      h == '10.0.3.2' ||
      h.startsWith('127.') ||
      h == '0.0.0.0' ||
      h == '::1' ||
      h == '[::1]';
}
