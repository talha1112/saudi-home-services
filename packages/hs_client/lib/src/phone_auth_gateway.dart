import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';

import 'errors.dart';

sealed class PhoneCodeResult {
  const PhoneCodeResult();
}

/// The SMS was sent; the person must type the code.
class CodeSent extends PhoneCodeResult {
  const CodeSent({required this.verificationId, this.resendToken, required this.timeout});

  final String verificationId;
  final int? resendToken;
  final Duration timeout;
}

/// Firebase verified the number without a typed code (instant verification, or a number configured for testing with auto-verification).
class AutoVerified extends PhoneCodeResult {
  const AutoVerified(this.idToken);

  final String idToken;
}

/// The Firebase side of phone sign-in, behind an interface so the sign-in logic can be tested without Firebase.
abstract class PhoneAuthGateway {
  /// Sends the SMS code to [phoneE164] (E.164, for example +966501234567).
  Future<PhoneCodeResult> sendCode({required String phoneE164, int? resendToken, String? languageCode});

  /// Checks the typed code and returns a fresh Firebase ID token.
  Future<String> confirmCode({required String verificationId, required String smsCode});

  /// Tokens produced when Android reads the SMS by itself AFTER [sendCode] returned [CodeSent].
  Stream<String> get autoVerifiedTokens;

  /// Forgets the Firebase session. The backend session is the app's source of truth.
  Future<void> signOut();
}

AuthIssue issueForFirebaseCode(String code) {
  switch (code) {
    case 'invalid-phone-number':
    case 'missing-phone-number':
      return AuthIssue.invalidPhone;
    case 'invalid-verification-code':
    case 'missing-verification-code':
      return AuthIssue.invalidCode;
    case 'session-expired':
    case 'code-expired':
    case 'invalid-verification-id':
      return AuthIssue.codeExpired;
    case 'too-many-requests':
    case 'quota-exceeded':
      return AuthIssue.tooManyRequests;
    case 'network-request-failed':
      return AuthIssue.network;
    case 'user-disabled':
      return AuthIssue.accountSuspended;
    case 'app-not-authorized':
    case 'missing-client-identifier':
    case 'invalid-app-credential':
    case 'missing-app-credential':
    case 'operation-not-allowed':
      return AuthIssue.appNotAuthorized;
    case 'captcha-check-failed':
      return AuthIssue.verificationFailed;
    default:
      return AuthIssue.generic;
  }
}

class FirebasePhoneAuthGateway implements PhoneAuthGateway {
  FirebasePhoneAuthGateway({FirebaseAuth? auth, this.codeTimeout = const Duration(seconds: 60)}) : _auth = auth ?? FirebaseAuth.instance;

  final FirebaseAuth _auth;
  final Duration codeTimeout;
  final StreamController<String> _auto = StreamController<String>.broadcast();

  @override
  Stream<String> get autoVerifiedTokens => _auto.stream;

  @override
  Future<PhoneCodeResult> sendCode({required String phoneE164, int? resendToken, String? languageCode}) async {
    if (languageCode != null) await _auth.setLanguageCode(languageCode);
    final completer = Completer<PhoneCodeResult>();

    await _auth.verifyPhoneNumber(
      phoneNumber: phoneE164,
      forceResendingToken: resendToken,
      timeout: codeTimeout,
      verificationCompleted: (credential) async {
        try {
          final token = await _idTokenFor(credential);
          if (completer.isCompleted) {
            _auto.add(token); // the SMS was read after the code screen was already showing
          } else {
            completer.complete(AutoVerified(token));
          }
        } catch (e) {
          if (!completer.isCompleted) completer.completeError(_failure(e));
        }
      },
      verificationFailed: (e) {
        if (!completer.isCompleted) completer.completeError(PhoneAuthFailure(issueForFirebaseCode(e.code)));
      },
      codeSent: (verificationId, token) {
        if (!completer.isCompleted) completer.complete(CodeSent(verificationId: verificationId, resendToken: token, timeout: codeTimeout));
      },
      codeAutoRetrievalTimeout: (_) {},
    );

    return completer.future.timeout(codeTimeout + const Duration(seconds: 15), onTimeout: () => throw const PhoneAuthFailure(AuthIssue.network));
  }

  @override
  Future<String> confirmCode({required String verificationId, required String smsCode}) async {
    try {
      return await _idTokenFor(PhoneAuthProvider.credential(verificationId: verificationId, smsCode: smsCode));
    } catch (e) {
      throw _failure(e);
    }
  }

  @override
  Future<void> signOut() => _auth.signOut();

  Future<String> _idTokenFor(AuthCredential credential) async {
    final result = await _auth.signInWithCredential(credential);
    final token = await result.user?.getIdToken();
    if (token == null) throw const PhoneAuthFailure(AuthIssue.verificationFailed);
    return token;
  }

  PhoneAuthFailure _failure(Object e) {
    if (e is PhoneAuthFailure) return e;
    if (e is FirebaseAuthException) return PhoneAuthFailure(issueForFirebaseCode(e.code));
    return const PhoneAuthFailure(AuthIssue.generic);
  }
}
