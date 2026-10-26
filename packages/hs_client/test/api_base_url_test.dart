import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';

void main() {
  group('debug builds', () {
    test('fall back to the emulator host only when nothing is supplied', () {
      expect(resolveApiBaseUrl('', isDebug: true), 'http://10.0.2.2:3001/api/v1');
      expect(resolveApiBaseUrl('   ', isDebug: true), 'http://10.0.2.2:3001/api/v1');
    });

    test('accept an explicit http or https address', () {
      expect(resolveApiBaseUrl('http://192.168.1.20:3001/api/v1', isDebug: true), 'http://192.168.1.20:3001/api/v1');
      expect(resolveApiBaseUrl('https://staging.example.com/api/v1/', isDebug: true), 'https://staging.example.com/api/v1');
    });
  });

  group('release builds', () {
    test('require the address: there is no fallback', () {
      expect(() => resolveApiBaseUrl('', isDebug: false), throwsA(isA<ApiConfigError>()));
      expect(() => resolveApiBaseUrl('  ', isDebug: false), throwsA(isA<ApiConfigError>()));
    });

    test('require https', () {
      expect(() => resolveApiBaseUrl('http://api.example.com/api/v1', isDebug: false), throwsA(isA<ApiConfigError>()));
      expect(resolveApiBaseUrl('https://api.example.com/api/v1', isDebug: false), 'https://api.example.com/api/v1');
    });

    test('refuse local and emulator addresses even over https', () {
      for (final host in ['localhost', '10.0.2.2', '127.0.0.1', '0.0.0.0', 'app.localhost']) {
        expect(() => resolveApiBaseUrl('https://$host/api/v1', isDebug: false), throwsA(isA<ApiConfigError>()), reason: host);
      }
    });

    test('refuse malformed addresses, other schemes, credentials, queries and fragments', () {
      for (final bad in [
        'api.example.com/api/v1',
        'ftp://api.example.com',
        'https://user:pw@api.example.com/api/v1',
        'https://api.example.com/api/v1?x=1',
        'https://api.example.com/api/v1#f',
        'https://',
      ]) {
        expect(() => resolveApiBaseUrl(bad, isDebug: false), throwsA(isA<ApiConfigError>()), reason: bad);
      }
    });

    test('the error never repeats the supplied value', () {
      try {
        resolveApiBaseUrl('https://user:secret@api.example.com', isDebug: false);
        fail('should throw');
      } on ApiConfigError catch (e) {
        expect(e.toString(), isNot(contains('secret')));
      }
    });
  });
}
