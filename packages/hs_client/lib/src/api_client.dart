import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'account_models.dart';
import 'booking_models.dart';
import 'chat.dart';
import 'customer_booking_models.dart';
import 'models.dart';
import 'worker_job_models.dart';
import 'worker_models.dart';

/// The few backend calls the apps need for sign-in, session renewal and push registration. Every request is JSON over the configured base
/// URL (use HTTPS outside local development). Nothing is logged, and exceptions never carry request or response bodies.
class HsApi {
  HsApi({
    required String baseUrl,
    http.Client? client,
    this._timeout = const Duration(seconds: 20),
    DateTime Function()? clock,
    this.allowCleartextUploads = false,
  }) : _base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
       _client = client ?? http.Client(),
       _clock = clock ?? DateTime.now;

  final String _base;
  final http.Client _client;
  final Duration _timeout;
  final DateTime Function() _clock;

  /// Whether a signed upload address may use plain http. Only for development storage; release builds keep this false.
  final bool allowCleartextUploads;

  /// Exchanges a Firebase ID token for a backend session. The phone number comes from the token, never from the app.
  Future<Session> signInWithFirebase({required String idToken, required AppKind app}) async {
    final json = await _json('POST', '/auth/firebase/phone', body: {'idToken': idToken, 'app': app.name});
    return Session.fromApi(json, _clock());
  }

  /// Refresh tokens are single use: the response carries the next one, which must be stored before anything else is done.
  Future<Session> refresh(String refreshToken) async {
    final json = await _json('POST', '/auth/refresh', body: {'refreshToken': refreshToken});
    return Session.fromApi(json, _clock());
  }

  /// Ends the session that owns this refresh token. The backend always answers 204.
  Future<void> logout(String refreshToken) => _json('POST', '/auth/logout', body: {'refreshToken': refreshToken});

  Future<AuthUser> me(String accessToken) async => AuthUser.fromJson(await _json('GET', '/auth/me', accessToken: accessToken));

  /// Registers (or refreshes) this device for push. Returns the device id used to revoke it later. Idempotent for the same token.
  Future<String> registerDevice({required String accessToken, required String platform, required String token}) async {
    final json = await _json('POST', '/devices', accessToken: accessToken, body: {'platform': platform, 'provider': 'FCM', 'token': token});
    return json['id'] as String;
  }

  /// Stops pushes to one of the caller's devices. A device that is already gone counts as done.
  Future<void> revokeDevice({required String accessToken, required String deviceId}) async {
    try {
      await _json('DELETE', '/devices/$deviceId', accessToken: accessToken);
    } on ApiException catch (e) {
      if (e.status != 404) rethrow;
    }
  }

  // ------------------------------------------------------------------ worker onboarding

  /// Public catalog: service categories with their services (`GET /catalog`) and the launch cities (`GET /catalog/cities`).
  Future<Catalog> catalog() async {
    final services = await _json('GET', '/catalog');
    final cities = await _json('GET', '/catalog/cities');
    return Catalog(
      categories: [for (final c in (services['categories'] as List<dynamic>? ?? const [])) CatalogCategory.fromJson(c as Map<String, dynamic>)],
      cities: [for (final c in (cities['items'] as List<dynamic>? ?? const [])) City.fromJson(c as Map<String, dynamic>)],
    );
  }

  /// Everything about the signed-in worker's application, including the current verification state.
  Future<WorkerOnboarding> workerOnboarding(String accessToken) async =>
      WorkerOnboarding.fromJson(await _json('GET', '/workers/me/onboarding', accessToken: accessToken));

  Future<WorkerOnboarding> updateWorkerProfile(
    String accessToken, {
    String? fullName,
    String? fullNameAr,
    String? bio,
    int? yearsOfExperience,
  }) async => WorkerOnboarding.fromJson(
    await _json(
      'PUT',
      '/workers/me/profile',
      accessToken: accessToken,
      body: {'fullName': ?fullName, 'fullNameAr': ?fullNameAr, 'bio': ?bio, 'yearsOfExperience': ?yearsOfExperience},
    ),
  );

  Future<WorkerOnboarding> setWorkerServices(String accessToken, List<String> serviceIds) async => WorkerOnboarding.fromJson(
    await _json(
      'PUT',
      '/workers/me/services',
      accessToken: accessToken,
      body: {
        'services': [
          for (final id in serviceIds) {'serviceId': id},
        ],
      },
    ),
  );

  Future<WorkerOnboarding> setWorkerAreas(String accessToken, List<String> cityIds) async =>
      WorkerOnboarding.fromJson(await _json('PUT', '/workers/me/areas', accessToken: accessToken, body: {'cityIds': cityIds}));

  Future<WorkerOnboarding> setWorkerAvailability(String accessToken, List<AvailabilityWindow> windows) async => WorkerOnboarding.fromJson(
    await _json(
      'PUT',
      '/workers/me/availability',
      accessToken: accessToken,
      body: {
        'windows': [for (final w in windows) w.toJson()],
      },
    ),
  );

  /// Step 1 of a document upload: registers the file and returns the signed address to PUT it to. 503 DOCUMENT_STORAGE_NOT_CONFIGURED while
  /// the backend has no storage: nothing is created then.
  Future<DocumentUploadTicket> registerWorkerDocument(
    String accessToken, {
    required DocumentKind kind,
    required String fileName,
    required String mimeType,
    required int sizeBytes,
    String? expiresOn,
  }) async => DocumentUploadTicket.fromJson(
    await _json(
      'POST',
      '/workers/me/documents',
      accessToken: accessToken,
      body: {'type': kind.wire, 'fileName': fileName, 'mimeType': mimeType, 'sizeBytes': sizeBytes, 'expiresOn': ?expiresOn},
    ),
  );

  /// Step 2: sends the bytes to the signed address the backend handed out. No Authorization header is sent there, redirects are not followed,
  /// and neither the address nor the bytes appear in any error.
  Future<void> uploadToSignedUrl(DocumentUploadTicket ticket, Uint8List bytes) async {
    final uri = Uri.tryParse(ticket.uploadUrl);
    final allowed = uri != null && uri.host.isNotEmpty && (uri.scheme == 'https' || (allowCleartextUploads && uri.scheme == 'http'));
    if (!allowed) throw const ApiException(status: 0, code: 'UPLOAD_URL_REJECTED');
    final request = http.Request('PUT', uri)
      ..followRedirects = false
      ..bodyBytes = bytes;
    ticket.headers.forEach((k, v) {
      if (k.toLowerCase() != 'authorization') request.headers[k] = v;
    });
    http.Response response;
    try {
      response = await http.Response.fromStream(await _client.send(request).timeout(const Duration(minutes: 2))).timeout(const Duration(minutes: 2));
    } on TimeoutException {
      throw const ApiException(status: 0, code: 'NETWORK');
    } on SocketException {
      throw const ApiException(status: 0, code: 'NETWORK');
    } on http.ClientException {
      throw const ApiException(status: 0, code: 'NETWORK');
    } on HandshakeException {
      throw const ApiException(status: 0, code: 'NETWORK');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(status: response.statusCode, code: 'UPLOAD_FAILED');
    }
  }

  /// Step 3: tells the backend the file is there. The server inspects the stored object itself (real size, signature, malware scan) and
  /// answers with the scan state; the answer is what counts, not this app's own check.
  Future<WorkerDocument> confirmWorkerDocument(String accessToken, String documentId) async =>
      WorkerDocument.fromJson(await _json('POST', '/workers/me/documents/$documentId/confirm', accessToken: accessToken, body: const {}));

  Future<void> deleteWorkerDocument(String accessToken, String documentId) async {
    try {
      await _json('DELETE', '/workers/me/documents/$documentId', accessToken: accessToken);
    } on ApiException catch (e) {
      if (e.status != 404) rethrow;
    }
  }

  Future<VerificationInfo> workerVerification(String accessToken) async =>
      VerificationInfo.fromJson(await _json('GET', '/workers/me/verification', accessToken: accessToken));

  /// Submits (or resubmits) the application. 409 VERIFICATION_INCOMPLETE carries `details.missing`; 409 INVALID_STATE when the server does
  /// not allow a submission in the current state.
  Future<VerificationInfo> submitWorkerVerification(String accessToken) async =>
      VerificationInfo.fromJson(await _json('POST', '/workers/me/verification/submit', accessToken: accessToken, body: const {}));

  // ------------------------------------------------------------------ bookings

  /// Creates a booking request for the signed-in customer. The backend validates every field (coordinates in range, address length...) and
  /// answers 400 with field messages otherwise.
  Future<BookingView> createBooking(String accessToken, CreateBookingRequest request) async =>
      BookingView.fromJson(await _json('POST', '/bookings', accessToken: accessToken, body: request.toJson()));

  /// The customer's bookings, newest first. [createdFrom] limits the list to bookings created on or after that moment (used to detect a
  /// request that was in fact created although its answer never arrived).
  Future<List<BookingSummary>> myBookings(String accessToken, {List<String>? statuses, DateTime? createdFrom, int limit = 20}) async {
    final query = <String, String>{
      'limit': '$limit',
      'sort': 'newest',
      if (statuses != null && statuses.isNotEmpty) 'status': statuses.join(','),
      if (createdFrom != null) 'createdFrom': createdFrom.toUtc().toIso8601String(),
    };
    final json = await _json('GET', '/bookings?${Uri(queryParameters: query).query}', accessToken: accessToken);
    return [for (final i in (json['items'] as List<dynamic>? ?? const [])) BookingSummary.fromJson(i as Map<String, dynamic>)];
  }

  /// A booking as its owner sees it (the full address and exact point are always visible to the customer).
  Future<BookingView> customerBooking(String accessToken, String bookingId) async =>
      BookingView.fromJson(await _json('GET', '/bookings/${Uri.encodeComponent(bookingId)}', accessToken: accessToken));

  /// A booking as the assigned worker sees it: the city and district always; the street, building, notes and exact point only once the
  /// customer has paid (the backend decides, the app just shows what it is given).
  Future<BookingView> workerBooking(String accessToken, String bookingId) async =>
      BookingView.fromJson(await _json('GET', '/workers/me/bookings/${Uri.encodeComponent(bookingId)}', accessToken: accessToken));

  // ------------------------------------------------------------------ chat (customer and the assigned worker)

  /// The conversation of a booking. Without [afterSeq] / [beforeSeq] it is the latest page, oldest first; [afterSeq] returns what came after
  /// a known message. Both sides of a booking may read it; anyone else gets 404.
  Future<ChatPage> chatMessages(String accessToken, String bookingId, {int? afterSeq, int? beforeSeq, int limit = 50}) async {
    final query = <String, String>{'limit': '$limit', 'afterSeq': ?afterSeq?.toString(), 'beforeSeq': ?beforeSeq?.toString()};
    return ChatPage.fromJson(
      await _json('GET', '/bookings/${Uri.encodeComponent(bookingId)}/messages?${Uri(queryParameters: query).query}', accessToken: accessToken),
    );
  }

  /// Sends a message. The same [clientMessageId] on a retry returns the original message instead of creating a second one.
  Future<ChatMessage> sendChatMessage(String accessToken, String bookingId, {required String clientMessageId, required String body}) async =>
      ChatMessage.fromJson(
        await _json(
          'POST',
          '/bookings/${Uri.encodeComponent(bookingId)}/messages',
          accessToken: accessToken,
          body: {'clientMessageId': clientMessageId, 'body': body},
        ),
        fromMe: true,
      );

  /// Reports messages up to [upToSeq] as `DELIVERED` or `READ`. Only moves forward.
  Future<void> chatReceipt(String accessToken, String bookingId, {required String kind, required int upToSeq}) async {
    await _json(
      'POST',
      '/bookings/${Uri.encodeComponent(bookingId)}/messages/receipts',
      accessToken: accessToken,
      body: {'kind': kind, 'upToSeq': upToSeq},
    );
  }

  // ------------------------------------------------------------------ support (the person's conversation with the administrators)

  /// The signed-in person's support conversation. [afterSeq] returns what came after a known message. An empty list means no conversation yet.
  Future<ChatPage> supportMessages(String accessToken, {int? afterSeq, int limit = 100}) async {
    final query = <String, String>{'limit': '$limit', 'afterSeq': ?afterSeq?.toString()};
    return ChatPage.fromJson(await _json('GET', '/support/messages?${Uri(queryParameters: query).query}', accessToken: accessToken));
  }

  /// Writes to support. The first message starts the conversation; the same [clientMessageId] on a retry returns the original message.
  Future<ChatMessage> sendSupportMessage(String accessToken, {required String clientMessageId, required String body}) async => ChatMessage.fromJson(
    await _json('POST', '/support/messages', accessToken: accessToken, body: {'clientMessageId': clientMessageId, 'body': body}),
    fromMe: true,
  );

  // ------------------------------------------------------------------ customer: quotes, choosing a worker, paying

  /// The booking in full, as its owner sees it.
  Future<BookingDetail> bookingDetail(String accessToken, String bookingId) async =>
      BookingDetail.fromJson(await _json('GET', '/bookings/${Uri.encodeComponent(bookingId)}', accessToken: accessToken));

  /// Live quotes on the customer's booking, cheapest first.
  Future<List<CustomerQuote>> bookingQuotes(String accessToken, String bookingId) async {
    final json = await _json('GET', '/bookings/${Uri.encodeComponent(bookingId)}/quotes?limit=50&sort=price_asc', accessToken: accessToken);
    return [for (final i in (json['items'] as List<dynamic>? ?? const [])) CustomerQuote.fromJson(i as Map<String, dynamic>)];
  }

  /// Chooses one quote: the booking moves to PAYMENT_PENDING and the other quotes are rejected. [expectedVersion] makes the server refuse
  /// (409 QUOTE_CHANGED) if the worker changed the quote after the customer saw it. No price is ever sent.
  Future<BookingDetail> acceptQuote(String accessToken, String bookingId, String quoteId, {int? expectedVersion}) async => BookingDetail.fromJson(
    await _json(
      'POST',
      '/bookings/${Uri.encodeComponent(bookingId)}/quotes/${Uri.encodeComponent(quoteId)}/accept',
      accessToken: accessToken,
      body: {'expectedVersion': ?expectedVersion},
    ),
  );

  /// Starts paying for a PAYMENT_PENDING booking. The amount is the agreed total and cannot be sent. The same [idempotencyKey] returns the
  /// same attempt, so a retry never starts a second payment. 503 PAYMENT_PROVIDER_NOT_CONFIGURED while no provider is set up.
  Future<PaymentAttempt> startPayment(String accessToken, String bookingId, {required String idempotencyKey}) async => PaymentAttempt.fromJson(
    await _json(
      'POST',
      '/bookings/${Uri.encodeComponent(bookingId)}/payments',
      accessToken: accessToken,
      body: const {},
      headers: {'Idempotency-Key': idempotencyKey},
    ),
  );

  /// The assigned worker's latest shared position, for the booking's customer. Answers "unavailable" (with the reason) rather than a made-up point.
  Future<LiveLocation> workerPosition(String accessToken, String bookingId) async =>
      LiveLocation.fromJson(await _json('GET', '/bookings/${Uri.encodeComponent(bookingId)}/location', accessToken: accessToken));

  /// Pays in cash: the booking is confirmed at once and the customer pays the agreed total to the worker in person. Safe to repeat.
  Future<BookingDetail> payCash(String accessToken, String bookingId) async => BookingDetail.fromJson(
    await _json('POST', '/bookings/${Uri.encodeComponent(bookingId)}/payments/cash', accessToken: accessToken, body: const {}),
  );

  Future<PaymentAttempt> payment(String accessToken, String paymentId) async =>
      PaymentAttempt.fromJson(await _json('GET', '/payments/${Uri.encodeComponent(paymentId)}', accessToken: accessToken));

  // ------------------------------------------------------------------ worker: requests, quotes and assigned jobs

  /// Open requests this worker can quote on (their services, their cities). The place is the city and district only.
  Future<PagedList<WorkerRequest>> workerRequests(String accessToken, {int page = 1, int limit = 20, String sort = 'soonest'}) async =>
      PagedList.fromJson(
        await _json(
          'GET',
          '/workers/me/requests?${Uri(queryParameters: {'page': '$page', 'limit': '$limit', 'sort': sort}).query}',
          accessToken: accessToken,
        ),
        WorkerRequest.fromJson,
      );

  /// One request in detail. A request the worker is not eligible for is a 404.
  Future<WorkerRequest> workerRequest(String accessToken, String bookingId) async =>
      WorkerRequest.fromJson(await _json('GET', '/workers/me/requests/${Uri.encodeComponent(bookingId)}', accessToken: accessToken));

  /// Sends the worker's quote. One quote per worker per request: a second send answers 409 QUOTE_EXISTS.
  Future<WorkerQuote> submitQuote(String accessToken, String bookingId, SubmitQuoteRequest request) async => WorkerQuote.fromJson(
    await _json('POST', '/workers/me/requests/${Uri.encodeComponent(bookingId)}/quote', accessToken: accessToken, body: request.toJson()),
  );

  Future<PagedList<WorkerQuote>> workerQuotes(String accessToken, {List<String>? statuses, int page = 1, int limit = 20}) async {
    final query = <String, String>{'page': '$page', 'limit': '$limit', if (statuses != null && statuses.isNotEmpty) 'status': statuses.join(',')};
    return PagedList.fromJson(
      await _json('GET', '/workers/me/quotes?${Uri(queryParameters: query).query}', accessToken: accessToken),
      WorkerQuote.fromJson,
    );
  }

  Future<WorkerQuote> withdrawWorkerQuote(String accessToken, String quoteId) async => WorkerQuote.fromJson(
    await _json('POST', '/workers/me/quotes/${Uri.encodeComponent(quoteId)}/withdraw', accessToken: accessToken, body: const {}),
  );

  /// Bookings assigned to this worker (their quote was accepted), newest first.
  Future<PagedList<WorkerJob>> workerJobs(String accessToken, {List<String>? statuses, int page = 1, int limit = 20}) async {
    final query = <String, String>{
      'page': '$page',
      'limit': '$limit',
      'sort': 'newest',
      if (statuses != null && statuses.isNotEmpty) 'status': statuses.join(','),
    };
    return PagedList.fromJson(
      await _json('GET', '/workers/me/bookings?${Uri(queryParameters: query).query}', accessToken: accessToken),
      WorkerJob.fromJson,
    );
  }

  /// One assigned booking. Another worker's booking is a 404.
  Future<WorkerJob> workerJob(String accessToken, String bookingId) async =>
      WorkerJob.fromJson(await _json('GET', '/workers/me/bookings/${Uri.encodeComponent(bookingId)}', accessToken: accessToken));

  /// CONFIRMED -> IN_PROGRESS. The backend refuses it unless the booking is this worker's and has been paid.
  Future<WorkerJob> startWorkerJob(String accessToken, String bookingId) async => WorkerJob.fromJson(
    await _json('POST', '/workers/me/bookings/${Uri.encodeComponent(bookingId)}/start', accessToken: accessToken, body: const {}),
  );

  /// The assigned worker reports where they are. The server accepts it only while sharing is open (the booking paid and not finished), and
  /// refuses implausible, stale or too frequent readings (409 LOCATION_SHARING_NOT_ACTIVE, 400 LOCATION_*, 429 LOCATION_TOO_FREQUENT).
  Future<void> reportPosition(
    String accessToken,
    String bookingId, {
    required double latitude,
    required double longitude,
    required DateTime recordedAt,
    double? accuracyMeters,
    double? headingDegrees,
    double? speedMps,
  }) async {
    await _json(
      'POST',
      '/workers/me/bookings/${Uri.encodeComponent(bookingId)}/location',
      accessToken: accessToken,
      body: {
        'latitude': latitude,
        'longitude': longitude,
        'recordedAt': recordedAt.toUtc().toIso8601String(),
        'accuracyMeters': ?accuracyMeters,
        'headingDegrees': ?headingDegrees,
        'speedMps': ?speedMps,
      },
    );
  }

  /// The worker confirms receiving the cash for a CASH booking (once the work has started).
  Future<WorkerJob> confirmCashCollected(String accessToken, String bookingId) async => WorkerJob.fromJson(
    await _json('POST', '/workers/me/bookings/${Uri.encodeComponent(bookingId)}/cash-collected', accessToken: accessToken, body: const {}),
  );

  /// IN_PROGRESS -> COMPLETED.
  Future<WorkerJob> completeWorkerJob(String accessToken, String bookingId) async => WorkerJob.fromJson(
    await _json('POST', '/workers/me/bookings/${Uri.encodeComponent(bookingId)}/complete', accessToken: accessToken, body: const {}),
  );

  // ------------------------------------------------------------------ my account

  /// Takes the signed-in worker online or offline; answers whether they are online now. Offline: no new requests, no new-request pushes.
  Future<bool> setWorkerOnline(String accessToken, bool online) async {
    final r = await _json('PUT', '/workers/me/online', accessToken: accessToken, body: {'isOnline': online});
    return r['isOnline'] as bool? ?? online;
  }

  /// Tells the server which language the person uses, so their notifications are written in it. [locale] is 'EN' or 'AR'.
  Future<void> setLocale(String accessToken, String locale) async {
    await _json('PATCH', '/account/locale', accessToken: accessToken, body: {'locale': locale});
  }

  /// A short-lived link to the signed-in worker's profile photo; null while there is none.
  Future<String?> workerPhotoUrl(String accessToken) async {
    final r = await _json('GET', '/workers/me/photo', accessToken: accessToken);
    return r['url'] as String?;
  }

  /// Sets the signed-in customer's name; answers the saved name.
  Future<String?> updateCustomerName(String accessToken, String fullName) async {
    final r = await _json('PATCH', '/customers/me', accessToken: accessToken, body: {'fullName': fullName});
    return r['fullName'] as String?;
  }

  /// My notifications, newest first, in my language.
  Future<PagedList<NotificationItem>> notifications(String accessToken, {int page = 1, int limit = 30}) async =>
      PagedList.fromJson(await _json('GET', '/notifications?page=$page&limit=$limit', accessToken: accessToken), NotificationItem.fromJson);

  Future<int> unreadNotifications(String accessToken) async =>
      ((await _json('GET', '/notifications/unread-count', accessToken: accessToken))['unread'] as num?)?.toInt() ?? 0;

  Future<void> markNotificationRead(String accessToken, String id) async {
    await _json('POST', '/notifications/${Uri.encodeComponent(id)}/read', accessToken: accessToken, body: const {});
  }

  Future<void> markAllNotificationsRead(String accessToken) async {
    await _json('POST', '/notifications/read-all', accessToken: accessToken, body: const {});
  }

  /// Offers I can see right now.
  Future<List<OfferItem>> offers(String accessToken) async {
    final r = await _json('GET', '/offers?limit=50', accessToken: accessToken);
    return [for (final o in (r['items'] as List<dynamic>? ?? const [])) OfferItem.fromJson(o as Map<String, dynamic>)];
  }

  /// My review of this booking, or null when I have not written one.
  Future<MyReview?> myReview(String accessToken, String bookingId) async {
    try {
      return MyReview.fromJson(await _json('GET', '/bookings/${Uri.encodeComponent(bookingId)}/review', accessToken: accessToken));
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }

  /// Reviews the worker of a completed booking (once; it cannot be edited).
  Future<MyReview> submitReview(String accessToken, String bookingId, {required int rating, String? comment}) async => MyReview.fromJson(
    await _json(
      'POST',
      '/bookings/${Uri.encodeComponent(bookingId)}/review',
      accessToken: accessToken,
      body: {'rating': rating, if (comment != null && comment.trim().isNotEmpty) 'comment': comment.trim()},
    ),
  );

  /// The worker's own published reviews with the average.
  Future<ReceivedReviews> receivedReviews(String accessToken, {int limit = 10}) async =>
      ReceivedReviews.fromJson(await _json('GET', '/reviews/received?limit=$limit', accessToken: accessToken));

  void close() => _client.close();

  Future<Map<String, dynamic>> _json(
    String method,
    String path, {
    Map<String, Object?>? body,
    String? accessToken,
    Map<String, String>? headers,
  }) async {
    final request = http.Request(method, Uri.parse('$_base$path'))
      ..headers['Accept'] = 'application/json'
      ..followRedirects = false;
    if (headers != null) request.headers.addAll(headers);
    if (accessToken != null) request.headers['Authorization'] = 'Bearer $accessToken';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }

    http.Response response;
    try {
      response = await http.Response.fromStream(await _client.send(request).timeout(_timeout)).timeout(_timeout);
    } on TimeoutException {
      throw const ApiException(status: 0, code: 'NETWORK');
    } on SocketException {
      throw const ApiException(status: 0, code: 'NETWORK');
    } on http.ClientException {
      throw const ApiException(status: 0, code: 'NETWORK');
    } on HandshakeException {
      throw const ApiException(status: 0, code: 'NETWORK');
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.isEmpty) return const {};
      final decoded = _decode(response);
      return decoded is Map<String, dynamic> ? decoded : const {};
    }

    final decoded = _decode(response);
    final map = decoded is Map<String, dynamic> ? decoded : const <String, dynamic>{};
    throw ApiException(
      status: response.statusCode,
      code: (map['code'] as String?) ?? 'HTTP_${response.statusCode}',
      message: map['message'] is String ? map['message'] as String : null,
      retryAfterSeconds: (map['retryAfterSeconds'] as num?)?.toInt() ?? int.tryParse(response.headers['retry-after'] ?? ''),
      details: map['details'] is Map<String, dynamic> ? map['details'] as Map<String, dynamic> : null,
      fieldMessages: map['message'] is List
          ? [
              for (final m in map['message'] as List)
                if (m is String) m,
            ]
          : const [],
    );
  }

  Object? _decode(http.Response response) {
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      return null;
    }
  }
}
