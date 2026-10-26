import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'models.dart';

/// Minimal secret storage. The real implementation uses the platform keystore (Android Keystore, iOS Keychain).
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SecureKeyValueStore implements KeyValueStore {
  SecureKeyValueStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

class MemoryKeyValueStore implements KeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// What survives an app restart: the refresh token and user (so the person stays signed in) and the id of this device's push registration.
/// Access tokens are never written to disk.
class SessionStore {
  SessionStore(this._kv);

  static const _sessionKey = 'hs.session.v1';
  static const _deviceKey = 'hs.device.v1';

  final KeyValueStore _kv;

  /// A missing, unreadable or corrupt record is "not signed in", never an error.
  Future<Session?> load() async {
    try {
      final raw = await _kv.read(_sessionKey);
      if (raw == null) return null;
      return Session.fromStored(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save(Session session) => _kv.write(_sessionKey, jsonEncode(session.toStored()));

  /// Forgets the session only (the push device id is cleaned up separately).
  Future<void> clearSession() => _kv.delete(_sessionKey);

  Future<void> clear() async {
    await _kv.delete(_sessionKey);
    await _kv.delete(_deviceKey);
  }

  Future<String?> readDeviceId() => _kv.read(_deviceKey);
  Future<void> writeDeviceId(String id) => _kv.write(_deviceKey, id);
  Future<void> clearDeviceId() => _kv.delete(_deviceKey);
}
