import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HsApi _api(Future<http.Response> Function(http.Request) h, {bool cleartext = false}) => HsApi(
  baseUrl: 'https://api.example.com/api/v1',
  client: MockClient(h),
  clock: () => DateTime.utc(2026, 11, 1, 10),
  allowCleartextUploads: cleartext,
);

http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

/// A signed-in worker controller over the stateful fake backend.
class _Rig {
  _Rig() {
    api.signInResult = fakeSession(
      user: fakeUser(role: 'WORKER', workerStatus: 'NOT_SUBMITTED'),
      accessExpiresAt: DateTime.now().add(const Duration(hours: 1)),
    );
    auth = AuthController(api: api, store: SessionStore(kv), phone: FakePhone(), kind: AppKind.worker);
    controller = WorkerOnboardingController(api: api, auth: auth, clock: clock.call);
  }

  final api = FakeApi();
  final kv = MemoryKeyValueStore();
  final clock = Clock();
  late final AuthController auth;
  late final WorkerOnboardingController controller;

  Future<void> signIn() async {
    await auth.sendCode('+966501234567');
    await auth.submitCode('123456');
  }

  Uint8List get pdf => Uint8List.fromList(List.filled(2048, 1));

  /// Fills every required item with real (fake-server) calls, so a submission is possible.
  Future<void> completeApplication() async {
    await controller.saveProfile(fullName: 'Ahmed Al-Qahtani', yearsOfExperience: 4);
    await controller.saveServices(['svc-ac']);
    await controller.saveAreas(['city-ruh']);
    await controller.saveAvailability(const [AvailabilityWindow(dayOfWeek: 0, startTime: '08:00', endTime: '17:00')]);
    await controller.uploadDocument(kind: DocumentKind.iqama, fileName: 'iqama.pdf', bytes: pdf);
  }
}

void main() {
  group('HsApi worker endpoints', () {
    test('profile update is PUT /workers/me/profile with only the supplied fields and the bearer token', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return _json(200, {
          'profile': {'id': 'wp', 'fullName': 'Ahmed', 'yearsOfExperience': 3},
          'services': [],
          'cities': [],
          'availability': [],
          'documents': [],
          'verification': {
            'status': 'NOT_SUBMITTED',
            'canSubmit': false,
            'missing': ['SERVICES'],
          },
        });
      });
      final result = await api.updateWorkerProfile('tok', fullName: 'Ahmed', yearsOfExperience: 3);
      expect(seen.method, 'PUT');
      expect(seen.url.path, '/api/v1/workers/me/profile');
      expect(seen.headers['Authorization'], 'Bearer tok');
      expect(jsonDecode(seen.body), {'fullName': 'Ahmed', 'yearsOfExperience': 3});
      expect(result.profile.fullName, 'Ahmed');
      expect(result.verification.missing, ['SERVICES']);
    });

    test('services, areas and availability use the documented bodies', () async {
      final bodies = <String, Object?>{};
      final api = _api((r) async {
        bodies['${r.method} ${r.url.path}'] = jsonDecode(r.body);
        return _json(200, {
          'profile': {},
          'verification': {'status': 'NOT_SUBMITTED'},
        });
      });
      await api.setWorkerServices('t', ['a', 'b']);
      await api.setWorkerAreas('t', ['c']);
      await api.setWorkerAvailability('t', const [AvailabilityWindow(dayOfWeek: 1, startTime: '08:00', endTime: '17:00')]);
      expect(bodies['PUT /api/v1/workers/me/services'], {
        'services': [
          {'serviceId': 'a'},
          {'serviceId': 'b'},
        ],
      });
      expect(bodies['PUT /api/v1/workers/me/areas'], {
        'cityIds': ['c'],
      });
      expect(bodies['PUT /api/v1/workers/me/availability'], {
        'windows': [
          {'dayOfWeek': 1, 'startTime': '08:00', 'endTime': '17:00'},
        ],
      });
    });

    test('the signed upload sends the bytes with the issued headers and NO Authorization header', () async {
      late http.Request seen;
      final api = _api((r) async {
        seen = r;
        return http.Response('', 200);
      });
      final ticket = DocumentUploadTicket.fromJson({
        'document': {'id': 'd1', 'type': 'IQAMA', 'status': 'PENDING_UPLOAD'},
        'uploadUrl': 'https://bucket.example.com/key?X-Sig=abc',
        'headers': {'Content-Type': 'application/pdf', 'Authorization': 'Bearer should-not-be-sent'},
      });
      await api.uploadToSignedUrl(ticket, Uint8List.fromList([1, 2, 3]));
      expect(seen.method, 'PUT');
      expect(seen.url.host, 'bucket.example.com');
      expect(seen.bodyBytes, [1, 2, 3]);
      expect(seen.headers['Content-Type'], startsWith('application/pdf'));
      expect(seen.headers.keys.map((k) => k.toLowerCase()), isNot(contains('authorization')));
    });

    test('a plain-http upload address is refused unless development storage is allowed; the address never appears in the error', () async {
      var sent = 0;
      Future<http.Response> handler(http.Request r) async {
        sent++;
        return http.Response('', 200);
      }

      final ticket = DocumentUploadTicket.fromJson({
        'document': {'id': 'd1', 'type': 'IQAMA', 'status': 'PENDING_UPLOAD'},
        'uploadUrl': 'http://127.0.0.1:3000/upload?sig=topsecret',
        'headers': <String, String>{},
      });
      await expectLater(
        _api(handler).uploadToSignedUrl(ticket, Uint8List(4)),
        throwsA(isA<ApiException>().having((e) => '$e', 'text', allOf(contains('UPLOAD_URL_REJECTED'), isNot(contains('topsecret'))))),
      );
      expect(sent, 0);
      await _api(handler, cleartext: true).uploadToSignedUrl(ticket, Uint8List(4));
      expect(sent, 1);
    });

    test('a storage refusal (403) surfaces as UPLOAD_FAILED', () async {
      final api = _api((r) async => http.Response('<Error>expired</Error>', 403));
      final ticket = DocumentUploadTicket.fromJson({
        'document': {'id': 'd1', 'type': 'IQAMA', 'status': 'PENDING_UPLOAD'},
        'uploadUrl': 'https://bucket.example.com/key',
        'headers': <String, String>{},
      });
      await expectLater(api.uploadToSignedUrl(ticket, Uint8List(4)), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'UPLOAD_FAILED')));
    });

    test('error bodies keep the structured details and the validation messages', () async {
      final api = _api((r) async {
        if (r.url.path.endsWith('/submit')) {
          return _json(409, {
            'statusCode': 409,
            'code': 'VERIFICATION_INCOMPLETE',
            'message': 'Complete the required information before submitting',
            'details': {
              'missing': ['SERVICES', 'IDENTITY_DOCUMENT'],
            },
          });
        }
        return _json(400, {
          'statusCode': 400,
          'message': ['fullName must be longer than or equal to 2 characters'],
          'error': 'Bad Request',
        });
      });
      await expectLater(
        api.submitWorkerVerification('t'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'VERIFICATION_INCOMPLETE').having((e) => e.details?['missing'], 'missing', [
            'SERVICES',
            'IDENTITY_DOCUMENT',
          ]),
        ),
      );
      await expectLater(
        api.updateWorkerProfile('t', fullName: 'A'),
        throwsA(isA<ApiException>().having((e) => e.fieldMessages, 'messages', ['fullName must be longer than or equal to 2 characters'])),
      );
    });

    test('the catalog is read from the public endpoints without a token', () async {
      final seen = <String>[];
      final api = _api((r) async {
        seen.add('${r.url.path} ${r.headers['Authorization']}');
        if (r.url.path.endsWith('/cities')) {
          return _json(200, {
            'items': [
              {'id': 'c1', 'nameEn': 'Riyadh', 'nameAr': 'الرياض'},
            ],
          });
        }
        return _json(200, {
          'categories': [
            {
              'id': 'k1',
              'nameEn': 'Repair',
              'nameAr': 'إصلاح',
              'services': [
                {'id': 's1', 'categoryId': 'k1', 'nameEn': 'AC', 'nameAr': 'مكيف'},
              ],
            },
          ],
        });
      });
      final catalog = await api.catalog();
      expect(seen, ['/api/v1/catalog null', '/api/v1/catalog/cities null']);
      expect(catalog.categories.single.services.single.name(arabic: true), 'مكيف');
      expect(catalog.cities.single.name(arabic: false), 'Riyadh');
    });
  });

  group('profile and application data', () {
    test('a successful profile save is shown only after the server accepted it, and the stored user follows the server status', () async {
      final r = _Rig();
      await r.signIn();
      expect(await r.controller.saveProfile(fullName: 'Ahmed Al-Qahtani', fullNameAr: 'أحمد', yearsOfExperience: 4), isTrue);
      expect(r.controller.onboarding!.profile.fullName, 'Ahmed Al-Qahtani');
      expect(r.controller.onboarding!.profile.yearsOfExperience, 4);
      expect(r.controller.failure, isNull);
    });

    test('a validation error is reported with the server messages and nothing is changed', () async {
      final r = _Rig();
      await r.signIn();
      final ok = await r.controller.saveProfile(fullName: 'A');
      expect(ok, isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.validation);
      expect(r.controller.failure!.fieldMessages, isNotEmpty);
      expect(r.api.fullName, isNull);
    });

    test('a lost connection is reported as network and the next try can succeed', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['setWorkerServices'] = const ApiException(status: 0, code: 'NETWORK');
      expect(await r.controller.saveServices(['svc-ac']), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.network);
      expect(await r.controller.saveServices(['svc-ac']), isTrue);
      expect(r.controller.failure, isNull);
      expect(r.controller.onboarding!.serviceIds, {'svc-ac'});
    });

    test('a suspended worker is told changes are not allowed', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['updateWorkerProfile'] = const ApiException(status: 403, code: 'WORKER_SUSPENDED');
      expect(await r.controller.saveProfile(fullName: 'Ahmed'), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.notAllowed);
    });

    test('an expired session while saving ends the sign-in and is reported as sessionExpired', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['setWorkerAreas'] = const ApiException(status: 401, code: 'UNAUTHORIZED');
      r.api.refreshResults.add(const ApiException(status: 401, code: 'REFRESH_TOKEN_REVOKED'));
      expect(await r.controller.saveAreas(['city-ruh']), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.sessionExpired);
      expect(r.auth.status, AuthStatus.signedOut);
    });
  });

  group('documents', () {
    test('register -> signed upload -> confirm; the server\'s scan state is kept and NOT_SCANNED is never turned into "safe"', () async {
      final r = _Rig();
      await r.signIn();
      r.api.scanOnConfirm = 'NOT_SCANNED';
      expect(await r.controller.uploadDocument(kind: DocumentKind.nationalId, fileName: 'id.pdf', bytes: r.pdf), isTrue);
      expect(r.api.onboardingCalls, containsAllInOrder(['registerWorkerDocument', 'uploadToSignedUrl', 'confirmWorkerDocument']));
      expect(r.api.signedUploads, 1);
      final doc = r.controller.onboarding!.documents.single;
      expect(doc.status, 'UPLOADED');
      expect(doc.scanStatus, 'NOT_SCANNED');
      expect(doc.kind, DocumentKind.nationalId);
    });

    test('with storage unavailable (503) nothing is uploaded or recorded and the failure says so', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['registerWorkerDocument'] = const ApiException(status: 503, code: 'DOCUMENT_STORAGE_NOT_CONFIGURED');
      expect(await r.controller.uploadDocument(kind: DocumentKind.iqama, fileName: 'iqama.pdf', bytes: r.pdf), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.storageUnavailable);
      expect(r.api.signedUploads, 0);
      expect(r.api.workerDocuments, isEmpty);
      expect(r.controller.onboarding?.documents ?? const [], isEmpty);
    });

    test('a failed transfer to storage removes the registered document again', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['uploadToSignedUrl'] = const ApiException(status: 403, code: 'UPLOAD_FAILED');
      expect(await r.controller.uploadDocument(kind: DocumentKind.iqama, fileName: 'iqama.pdf', bytes: r.pdf), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.uploadFailed);
      expect(r.api.workerDocuments, isEmpty);
      expect(r.api.onboardingCalls, contains('deleteWorkerDocument'));
    });

    test('a file the server rejects (content or malware scan) is reported as rejected and does not count', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['confirmWorkerDocument'] = const ApiException(status: 422, code: 'FILE_REJECTED_BY_SCAN');
      expect(await r.controller.uploadDocument(kind: DocumentKind.iqama, fileName: 'iqama.pdf', bytes: r.pdf), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.fileRejected);
    });

    test('unsupported types and oversized files are refused locally without any request', () async {
      final r = _Rig();
      await r.signIn();
      expect(await r.controller.uploadDocument(kind: DocumentKind.other, fileName: 'notes.docx', bytes: r.pdf), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.unsupportedFile);
      expect(await r.controller.uploadDocument(kind: DocumentKind.other, fileName: 'big.pdf', bytes: Uint8List(kMaxDocumentBytes + 1)), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.fileTooLarge);
      expect(r.api.onboardingCalls, isEmpty);
    });

    test('deleting a document asks the server and then shows its list', () async {
      final r = _Rig();
      await r.signIn();
      await r.controller.uploadDocument(kind: DocumentKind.certificate, fileName: 'cert.png', bytes: r.pdf);
      final id = r.controller.onboarding!.documents.single.id;
      expect(await r.controller.deleteDocument(id), isTrue);
      expect(r.controller.onboarding!.documents, isEmpty);
    });

    test('the document limit and locked documents are reported, not hidden', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['registerWorkerDocument'] = const ApiException(status: 409, code: 'DOCUMENT_LIMIT');
      await r.controller.uploadDocument(kind: DocumentKind.other, fileName: 'a.pdf', bytes: r.pdf);
      expect(r.controller.failure!.issue, OnboardingIssue.documentLimit);
      r.api.failures['deleteWorkerDocument'] = const ApiException(status: 409, code: 'DOCUMENTS_LOCKED');
      await r.controller.deleteDocument('x');
      expect(r.controller.failure!.issue, OnboardingIssue.notAllowed);
    });
  });

  group('verification', () {
    test('submitting an incomplete application is refused by the server and the missing items are listed', () async {
      final r = _Rig();
      await r.signIn();
      await r.controller.refresh(force: true);
      expect(await r.controller.submit(), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.incomplete);
      expect(r.controller.failure!.missing, containsAll(['FULL_NAME', 'SERVICES', 'IDENTITY_DOCUMENT']));
      expect(r.api.workerStatus, 'NOT_SUBMITTED');
    });

    test('a complete application is submitted through the endpoint; the state and the stored user become SUBMITTED', () async {
      final r = _Rig();
      await r.signIn();
      await r.completeApplication();
      expect(r.controller.verification!.canSubmit, isTrue);
      expect(await r.controller.submit(), isTrue);
      expect(r.api.onboardingCalls, contains('submitWorkerVerification'));
      expect(r.controller.verification!.state, VerificationState.submitted);
      expect(r.controller.verification!.canSubmit, isFalse);
      expect(r.auth.user!.workerVerificationStatus, 'SUBMITTED');
      expect((await r.auth.store.load())!.user.workerVerificationStatus, 'SUBMITTED');
    });

    test('a second submission while under review is refused by the server (INVALID_STATE), not simulated', () async {
      final r = _Rig();
      await r.signIn();
      await r.completeApplication();
      await r.controller.submit();
      expect(await r.controller.submit(), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.invalidState);
    });

    for (final status in ['INFO_REQUIRED', 'REJECTED']) {
      test('resubmission is allowed from $status once the application is complete, and shows the reviewer message', () async {
        final r = _Rig();
        await r.signIn();
        await r.completeApplication();
        await r.controller.submit();
        r.api.workerStatus = status;
        r.api.reviewerNote = 'Please upload a clearer photo';
        await r.controller.refresh(force: true);
        expect(r.controller.verification!.note, 'Please upload a clearer photo');
        expect(r.controller.verification!.canSubmit, isTrue);
        expect(await r.controller.submit(), isTrue);
        expect(r.controller.verification!.state, VerificationState.submitted);
      });
    }

    test('status transitions come from the server: under review, approved, suspended', () async {
      final r = _Rig();
      await r.signIn();
      for (final entry in {
        'UNDER_REVIEW': VerificationState.underReview,
        'APPROVED': VerificationState.approved,
        'SUSPENDED': VerificationState.suspended,
      }.entries) {
        r.api.workerStatus = entry.key;
        await r.controller.refresh(force: true);
        expect(r.controller.verification!.state, entry.value);
        expect(r.auth.user!.workerVerificationStatus, entry.key);
        expect(r.controller.verification!.canSubmit, isFalse);
      }
    });

    test('a status the app does not know is kept as unknown, never guessed', () async {
      expect(VerificationState.parse('SOMETHING_NEW'), VerificationState.unknown);
      expect(VerificationState.parse(null), VerificationState.unknown);
    });
  });

  group('refresh throttling', () {
    test('entering a screen again within the interval does not call the server; force and an expired interval do', () async {
      final r = _Rig();
      await r.signIn();
      await r.controller.refresh();
      await r.controller.refresh();
      await r.controller.refresh();
      expect(r.api.onboardingCalls.where((c) => c == 'workerOnboarding'), hasLength(1));
      r.clock.now = r.clock.now.add(const Duration(seconds: 25));
      await r.controller.refresh();
      expect(r.api.onboardingCalls.where((c) => c == 'workerOnboarding'), hasLength(2));
      await r.controller.refresh(force: true);
      expect(r.api.onboardingCalls.where((c) => c == 'workerOnboarding'), hasLength(3));
    });

    test('concurrent refreshes share one request', () async {
      final r = _Rig();
      await r.signIn();
      await Future.wait([r.controller.refresh(), r.controller.refresh(), r.controller.refresh(force: true)]);
      expect(r.api.onboardingCalls.where((c) => c == 'workerOnboarding'), hasLength(1));
    });

    test('a failed refresh is not remembered as fresh, so the next entry tries again', () async {
      final r = _Rig();
      await r.signIn();
      r.api.failures['workerOnboarding'] = const ApiException(status: 0, code: 'NETWORK');
      expect(await r.controller.refresh(), isFalse);
      expect(r.controller.failure!.issue, OnboardingIssue.network);
      expect(await r.controller.refresh(), isTrue);
      expect(r.controller.failure, isNull);
    });

    test('a save that succeeded is not reported as failed because the follow-up reload failed', () async {
      final r = _Rig();
      await r.signIn();
      await r.controller.refresh(force: true);
      r.api.failures['workerOnboarding'] = const ApiException(status: 0, code: 'NETWORK');
      expect(await r.controller.uploadDocument(kind: DocumentKind.iqama, fileName: 'iqama.pdf', bytes: r.pdf), isTrue);
      expect(r.api.workerDocuments, hasLength(1));
    });
  });

  test('the catalog loads once and is cached', () async {
    final r = _Rig();
    await r.signIn();
    expect(await r.controller.loadCatalog(), isTrue);
    expect(await r.controller.loadCatalog(), isTrue);
    expect(r.api.onboardingCalls.where((c) => c == 'catalog'), hasLength(1));
    expect(r.controller.catalog!.cities, hasLength(2));
  });
}
