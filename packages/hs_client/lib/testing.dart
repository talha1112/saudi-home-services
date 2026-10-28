/// Test doubles for the sign-in and push parts, for this package's tests and for the apps' widget tests. Nothing here talks to Firebase or
/// the network. Not for production code.
library;

import 'dart:async';
import 'dart:typed_data';

import 'hs_client.dart';

AuthUser fakeUser({String id = 'user-1', String role = 'CUSTOMER', String? workerStatus, String? fullName}) => AuthUser(
  id: id,
  phone: '+966501234567',
  fullName: fullName,
  status: 'ACTIVE',
  roles: [role],
  activeRole: role,
  workerVerificationStatus: workerStatus,
);

Session fakeSession({
  String access = 'access-1',
  String refresh = 'refresh-1',
  DateTime? accessExpiresAt,
  DateTime? refreshExpiresAt,
  bool isNew = false,
  AuthUser? user,
}) => Session(
  accessToken: access,
  accessExpiresAt: accessExpiresAt ?? DateTime.now().add(const Duration(minutes: 15)),
  refreshToken: refresh,
  refreshExpiresAt: refreshExpiresAt ?? DateTime.now().add(const Duration(days: 30)),
  user: user ?? fakeUser(),
  isNewUser: isNew,
);

/// A scripted backend. Nothing here touches the network.
class FakeApi extends HsApi {
  FakeApi() : super(baseUrl: 'http://fake.invalid/api/v1');

  final List<String> calls = [];
  Object? signInResult; // Session or Exception
  final List<Object> refreshResults = []; // consumed in order; Session or Exception
  Object? registerResult = 'device-1';
  Object? revokeResult;
  Duration refreshDelay = Duration.zero;
  String? lastIdToken;
  AppKind? lastApp;
  String? lastRefreshTokenUsed;
  String? lastLogoutToken;
  String? lastRegisteredToken;
  String? lastRegisterPlatform;
  final List<String> revoked = [];
  Object? logoutResult;
  Duration revokeDelay = Duration.zero;
  Duration logoutDelay = Duration.zero;
  String? lastRevokeAccessToken;

  @override
  Future<Session> signInWithFirebase({required String idToken, required AppKind app}) async {
    calls.add('signIn');
    lastIdToken = idToken;
    lastApp = app;
    final r = signInResult;
    if (r is Exception) throw r;
    return r as Session;
  }

  @override
  Future<Session> refresh(String refreshToken) async {
    calls.add('refresh');
    lastRefreshTokenUsed = refreshToken;
    if (refreshDelay != Duration.zero) await Future<void>.delayed(refreshDelay);
    final r = refreshResults.removeAt(0);
    if (r is Exception) throw r;
    return r as Session;
  }

  @override
  Future<void> logout(String refreshToken) async {
    calls.add('logout');
    lastLogoutToken = refreshToken;
    if (logoutDelay != Duration.zero) await Future<void>.delayed(logoutDelay);
    final r = logoutResult;
    if (r is Exception) throw r;
  }

  @override
  Future<String> registerDevice({required String accessToken, required String platform, required String token}) async {
    calls.add('registerDevice');
    lastRegisteredToken = token;
    lastRegisterPlatform = platform;
    final r = registerResult;
    if (r is Exception) throw r;
    return r as String;
  }

  @override
  Future<void> revokeDevice({required String accessToken, required String deviceId}) async {
    calls.add('revokeDevice');
    revoked.add(deviceId);
    lastRevokeAccessToken = accessToken;
    if (revokeDelay != Duration.zero) await Future<void>.delayed(revokeDelay);
    final r = revokeResult;
    if (r is Exception) throw r;
  }

  // ------------------------------------------------------------------ worker onboarding: a small stateful stand-in for the real endpoints

  final List<String> onboardingCalls = [];

  /// Failures to inject: method name (for example 'registerWorkerDocument') -> an Exception thrown once, or [stickyFailures] for every call.
  final Map<String, Exception> failures = {};
  final Map<String, Exception> stickyFailures = {};

  String workerStatus = 'NOT_SUBMITTED';
  String? reviewerNote;
  String? fullName;
  String? fullNameAr;
  String? bio;
  int? yearsOfExperience;
  final Set<String> workerServices = {};
  final Set<String> workerCities = {};
  List<AvailabilityWindow> workerWindows = [];
  final List<Map<String, dynamic>> workerDocuments = [];

  /// Scan state the backend reports when a document is confirmed (PENDING, CLEAN, NOT_SCANNED, ERROR...).
  String scanOnConfirm = 'PENDING';
  int signedUploads = 0;
  String? lastUploadUrl;
  Map<String, String>? lastUploadHeaders;
  int _docSeq = 0;

  Catalog catalogResult = const Catalog(
    categories: [
      CatalogCategory(
        id: 'cat-1',
        nameEn: 'Home repair',
        nameAr: 'إصلاح المنزل',
        services: [
          CatalogService(id: 'svc-ac', categoryId: 'cat-1', nameEn: 'AC repair', nameAr: 'إصلاح المكيفات'),
          CatalogService(id: 'svc-plumb', categoryId: 'cat-1', nameEn: 'Plumbing', nameAr: 'السباكة'),
        ],
      ),
    ],
    cities: [
      City(id: 'city-ruh', nameEn: 'Riyadh', nameAr: 'الرياض'),
      City(id: 'city-jed', nameEn: 'Jeddah', nameAr: 'جدة'),
    ],
  );

  void _maybeFail(String name) {
    onboardingCalls.add(name);
    final once = failures.remove(name);
    if (once != null) throw once;
    final sticky = stickyFailures[name];
    if (sticky != null) throw sticky;
  }

  List<String> _missing() {
    final usableId = workerDocuments.any(
      (d) => (d['type'] == 'NATIONAL_ID' || d['type'] == 'IQAMA') && (d['status'] == 'UPLOADED' || d['status'] == 'ACCEPTED'),
    );
    return [
      if ((fullName ?? '').trim().isEmpty) 'FULL_NAME',
      if (yearsOfExperience == null) 'YEARS_OF_EXPERIENCE',
      if (workerServices.isEmpty) 'SERVICES',
      if (workerCities.isEmpty) 'SERVICE_AREAS',
      if (workerWindows.isEmpty) 'AVAILABILITY',
      if (!usableId) 'IDENTITY_DOCUMENT',
    ];
  }

  bool get _submittable => const ['NOT_SUBMITTED', 'INFO_REQUIRED', 'REJECTED'].contains(workerStatus);

  Map<String, dynamic> _verificationJson() => {
    'status': workerStatus,
    'note': reviewerNote,
    'submittedAt': null,
    'verifiedAt': null,
    'canSubmit': _submittable && _missing().isEmpty,
    'missing': _missing(),
    'history': <Object>[],
  };

  Map<String, dynamic> _onboardingJson() => {
    'profile': {'id': 'wp-1', 'fullName': fullName, 'fullNameAr': fullNameAr, 'bio': bio, 'yearsOfExperience': yearsOfExperience, 'isOnline': workerOnline},
    'services': [
      for (final id in workerServices) {'id': id},
    ],
    'cities': [
      for (final id in workerCities) {'id': id, 'nameEn': cityNames[id] ?? id, 'nameAr': cityNames[id] ?? id},
    ],
    'availability': [for (final w in workerWindows) w.toJson()],
    'documents': workerDocuments,
    'verification': _verificationJson(),
  };

  WorkerOnboarding _onboarding() => WorkerOnboarding.fromJson(_onboardingJson());

  // ------------------------------------------------------------------ customer bookings

  /// Requests received by createBooking, in order.
  final List<CreateBookingRequest> createdBookings = [];

  /// What createBooking answers: an Exception to throw, a BookingView to return, or null for "create and remember it".
  Object? createBookingResult;

  /// Make createBooking STORE the booking and then fail (the server created it but the answer never arrived).
  Exception? failAfterCreating;
  final List<BookingSummary> bookingList = [];
  DateTime? lastCreatedFrom;
  List<String>? lastStatuses;
  Object? myBookingsResult;
  int _bookingSeq = 0;

  @override
  Future<BookingView> createBooking(String accessToken, CreateBookingRequest request) async {
    calls.add('createBooking');
    createdBookings.add(request);
    final r = createBookingResult;
    if (r is Exception) throw r;
    if (r is BookingView) return r;
    final n = ++_bookingSeq;
    final fields = request.locationFields;
    final view = BookingView(
      id: 'booking-$n',
      reference: 'HS-$n',
      status: 'OPEN',
      preferredStartAt: request.preferredStartAt,
      preferredEndAt: request.preferredEndAt,
      expiresAt: request.preferredStartAt.add(const Duration(days: 2)),
      location: BookingLocation(
        cityId: request.cityId,
        district: fields['district'] as String?,
        addressLine: fields['addressLine'] as String?,
        building: fields['building'] as String?,
        locationNotes: fields['locationNotes'] as String?,
        latitude: (fields['latitude'] as num?)?.toDouble(),
        longitude: (fields['longitude'] as num?)?.toDouble(),
      ),
    );
    bookingList.insert(
      0,
      BookingSummary(
        id: view.id,
        reference: view.reference,
        status: 'OPEN',
        serviceId: request.serviceId,
        serviceNameEn: 'AC repair',
        serviceNameAr: 'إصلاح مكيف',
        cityId: request.cityId,
        isUrgent: request.isUrgent,
        preferredStartAt: request.preferredStartAt,
        preferredEndAt: request.preferredEndAt,
        createdAt: DateTime.now(),
        quoteCount: 0,
      ),
    );
    final late = failAfterCreating;
    if (late != null) {
      failAfterCreating = null;
      throw late;
    }
    return view;
  }

  @override
  Future<List<BookingSummary>> myBookings(String accessToken, {List<String>? statuses, DateTime? createdFrom, int limit = 20}) async {
    calls.add('myBookings');
    lastCreatedFrom = createdFrom;
    lastStatuses = statuses;
    final r = myBookingsResult;
    if (r is Exception) throw r;
    return List.of(bookingList);
  }

  // ------------------------------------------------------------------ live position

  /// What the customer reads for a booking (default: sharing not active). Set [positions] to put the worker somewhere.
  final Map<String, LiveLocation> positions = {};
  Object? positionResult;
  Object? reportResult;
  final List<({String bookingId, double latitude, double longitude, double? accuracy})> reportedPositions = [];

  @override
  Future<LiveLocation> workerPosition(String accessToken, String bookingId) async {
    calls.add('workerPosition');
    final r = positionResult;
    if (r is Exception) throw r;
    return positions[bookingId] ?? const LiveLocation.unavailable(LiveLocationReason.notActive);
  }

  @override
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
    calls.add('reportPosition');
    reportedPositions.add((bookingId: bookingId, latitude: latitude, longitude: longitude, accuracy: accuracyMeters));
    final r = reportResult;
    if (r is Exception) throw r;
    positions[bookingId] = LiveLocation.at(
      latitude: latitude,
      longitude: longitude,
      accuracyMeters: accuracyMeters,
      recordedAt: recordedAt,
      ageSeconds: 0,
    );
  }

  // ------------------------------------------------------------------ support

  /// The signed-in person's support conversation, as the server stores it.
  final List<ChatMessage> supportStore = [];
  Object? supportListResult;
  Object? supportSendResult;
  final List<String> supportSent = []; // clientMessageIds that reached the server

  void supportAdminReply(String body) {
    supportStore.add(
      ChatMessage(
        id: 'adm-${supportStore.length + 1}',
        clientMessageId: 'admin-${supportStore.length + 1}',
        body: body,
        fromMe: false,
        delivery: ChatDelivery.sent,
        seq: supportStore.length + 1,
        createdAt: DateTime.now().toUtc(),
      ),
    );
  }

  @override
  Future<ChatPage> supportMessages(String accessToken, {int? afterSeq, int limit = 100}) async {
    calls.add('supportMessages');
    final r = supportListResult;
    if (r is Exception) throw r;
    final items = [
      for (final m in supportStore)
        if (afterSeq == null || m.seq! > afterSeq) m,
    ];
    return ChatPage(items: items, lastSeq: supportStore.length, canSend: true, hasMore: false);
  }

  @override
  Future<ChatMessage> sendSupportMessage(String accessToken, {required String clientMessageId, required String body}) async {
    calls.add('sendSupportMessage');
    supportSent.add(clientMessageId);
    final r = supportSendResult;
    if (r is Exception) throw r;
    final existing = supportStore.where((m) => m.clientMessageId == clientMessageId);
    if (existing.isNotEmpty) return existing.first;
    final m = ChatMessage(
      id: 'sup-${supportStore.length + 1}',
      clientMessageId: clientMessageId,
      body: body,
      fromMe: true,
      delivery: ChatDelivery.sent,
      seq: supportStore.length + 1,
      createdAt: DateTime.now().toUtc(),
    );
    supportStore.add(m);
    return m;
  }

  // ------------------------------------------------------------------ chat

  /// Messages per booking, as the server stores them (seq from 1). [chatPeerMessage] adds one from the other side.
  final Map<String, List<ChatMessage>> chatStore = {};

  /// Bookings whose chat the signed-in person may use (otherwise 404, like someone else's booking).
  final Set<String> chatBookings = {};
  bool chatCanSend = true;
  Object? chatListResult;
  Object? chatSendResult;
  int chatOtherRead = 0;
  final List<String> chatSent = []; // clientMessageIds that reached the server, in order (duplicates included)
  final List<(String, int)> chatReceipts = [];

  void chatPeerMessage(String bookingId, String body) {
    final list = chatStore.putIfAbsent(bookingId, () => []);
    final seq = list.length + 1;
    list.add(
      ChatMessage(
        id: 'srv-$bookingId-$seq',
        clientMessageId: 'peer-$seq',
        body: body,
        fromMe: false,
        delivery: ChatDelivery.sent,
        seq: seq,
        createdAt: DateTime.now().toUtc(),
      ),
    );
  }

  @override
  Future<ChatPage> chatMessages(String accessToken, String bookingId, {int? afterSeq, int? beforeSeq, int limit = 50}) async {
    calls.add('chatMessages');
    final r = chatListResult;
    if (r is Exception) throw r;
    if (!chatBookings.contains(bookingId)) throw _notFound;
    final all = chatStore[bookingId] ?? const <ChatMessage>[];
    final items = [
      for (final m in all)
        if (afterSeq == null || m.seq! > afterSeq) m,
    ];
    return ChatPage(items: items, lastSeq: all.length, canSend: chatCanSend, hasMore: false, otherReadUpToSeq: chatOtherRead);
  }

  @override
  Future<ChatMessage> sendChatMessage(String accessToken, String bookingId, {required String clientMessageId, required String body}) async {
    calls.add('sendChatMessage');
    chatSent.add(clientMessageId);
    final r = chatSendResult;
    if (r is Exception) throw r;
    if (!chatBookings.contains(bookingId)) throw _notFound;
    if (!chatCanSend) {
      throw const ApiException(status: 409, code: 'CHAT_CLOSED', message: 'Messages can only be sent while the booking is confirmed or in progress');
    }
    final list = chatStore.putIfAbsent(bookingId, () => []);
    final existing = list.where((m) => m.clientMessageId == clientMessageId);
    if (existing.isNotEmpty) return existing.first;
    final m = ChatMessage(
      id: 'srv-$bookingId-${list.length + 1}',
      clientMessageId: clientMessageId,
      body: body,
      fromMe: true,
      delivery: ChatDelivery.sent,
      seq: list.length + 1,
      createdAt: DateTime.now().toUtc(),
    );
    list.add(m);
    return m;
  }

  @override
  Future<void> chatReceipt(String accessToken, String bookingId, {required String kind, required int upToSeq}) async {
    calls.add('chatReceipt');
    chatReceipts.add((kind, upToSeq));
  }

  // ------------------------------------------------------------------ customer: quotes, accepting, paying

  /// Bookings as their owner sees them in detail. A booking that is not here is "not found", like someone else's.
  final Map<String, BookingDetail> detailStore = {};

  /// Quotes on those bookings (live ones are listed).
  final List<CustomerQuote> customerQuoteList = [];
  Object? bookingDetailResult;
  Object? bookingQuotesResult;
  Object? acceptQuoteResult;
  Object? startPaymentResult;

  /// What a started payment looks like: the development mock (default) or a real hosted page at [paymentCheckoutUrl].
  bool simulatedPayments = true;
  String? paymentCheckoutUrl;
  Object? paymentResult;
  final List<(String, String, int?)> acceptedQuotes = [];
  final List<(String, String)> startedPayments = []; // bookingId, idempotency key
  final Map<String, PaymentAttempt> _attemptsByKey = {};
  final Map<String, PaymentAttempt> paymentStore = {};
  int _attemptSeq = 0;

  @override
  Future<BookingDetail> bookingDetail(String accessToken, String bookingId) async {
    calls.add('bookingDetail');
    final r = bookingDetailResult;
    if (r is Exception) throw r;
    return detailStore[bookingId] ?? (throw _notFound);
  }

  @override
  Future<List<CustomerQuote>> bookingQuotes(String accessToken, String bookingId) async {
    calls.add('bookingQuotes');
    final r = bookingQuotesResult;
    if (r is Exception) throw r;
    if (!detailStore.containsKey(bookingId)) throw _notFound;
    return [
      for (final q in customerQuoteList)
        if (q.bookingId == bookingId && q.canAccept) q,
    ];
  }

  @override
  Future<BookingDetail> acceptQuote(String accessToken, String bookingId, String quoteId, {int? expectedVersion}) async {
    calls.add('acceptQuote');
    acceptedQuotes.add((bookingId, quoteId, expectedVersion));
    final r = acceptQuoteResult;
    if (r is Exception) throw r;
    final detail = detailStore[bookingId] ?? (throw _notFound);
    final quote = customerQuoteList.firstWhere((q) => q.id == quoteId && q.bookingId == bookingId, orElse: () => throw _notFound);
    if (detail.status != 'OPEN') {
      throw ApiException(status: 409, code: 'BOOKING_NOT_OPEN', message: 'A ${detail.status.toLowerCase()} booking cannot accept a quote');
    }
    if (expectedVersion != null && expectedVersion != quote.version) {
      throw const ApiException(status: 409, code: 'QUOTE_CHANGED', message: 'The quote changed, please reload');
    }
    final accepted = BookingDetail(
      id: detail.id,
      reference: detail.reference,
      status: 'PAYMENT_PENDING',
      serviceNameEn: detail.serviceNameEn,
      serviceNameAr: detail.serviceNameAr,
      location: detail.location,
      isUrgent: detail.isUrgent,
      problemDescription: detail.problemDescription,
      preferredStartAt: detail.preferredStartAt,
      preferredEndAt: detail.preferredEndAt,
      expiresAt: detail.expiresAt,
      money: quote.money,
      worker: AssignedWorker(workerId: quote.worker.workerId, fullName: quote.worker.fullName, fullNameAr: quote.worker.fullNameAr),
      acceptedQuoteId: quote.id,
      paymentDueAt: DateTime.now().toUtc().add(const Duration(hours: 2)),
    );
    detailStore[bookingId] = accepted;
    return accepted;
  }

  @override
  Future<PaymentAttempt> startPayment(String accessToken, String bookingId, {required String idempotencyKey}) async {
    calls.add('startPayment');
    startedPayments.add((bookingId, idempotencyKey));
    final r = startPaymentResult;
    if (r is Exception) throw r;
    final detail = detailStore[bookingId] ?? (throw _notFound);
    if (detail.status != 'PAYMENT_PENDING') {
      throw ApiException(status: 409, code: 'BOOKING_NOT_PAYABLE', message: 'A ${detail.status.toLowerCase()} booking cannot be paid');
    }
    final existing = _attemptsByKey[idempotencyKey];
    if (existing != null) return existing;
    final n = ++_attemptSeq;
    final attempt = PaymentAttempt(
      id: 'pay-$n',
      bookingId: bookingId,
      status: 'PROCESSING',
      amountHalalas: detail.money?.totalHalalas ?? 0,
      currency: 'SAR',
      simulated: simulatedPayments,
      checkoutUrl: paymentCheckoutUrl ?? 'https://mock-checkout.invalid/pay/$n',
      checkoutExpiresAt: DateTime.now().toUtc().add(const Duration(minutes: 30)),
    );
    _attemptsByKey[idempotencyKey] = attempt;
    paymentStore[attempt.id] = attempt;
    return attempt;
  }

  @override
  Future<PaymentAttempt> payment(String accessToken, String paymentId) async {
    calls.add('payment');
    final r = paymentResult;
    if (r is Exception) throw r;
    return paymentStore[paymentId] ?? (throw _notFound);
  }

  // ------------------------------------------------------------------ worker requests, quotes and jobs

  /// Open requests the signed-in worker may quote on, as the backend would list them (city and district only).
  final List<WorkerRequest> workerRequestList = [];

  /// Quotes this worker has sent.
  final List<WorkerQuote> workerQuoteList = [];

  /// Bookings assigned to this worker. A booking that is not in this list is "not found" for the worker, like another worker's booking.
  final List<WorkerJob> workerJobList = [];

  /// An Exception to throw from the matching call (every call until cleared), or null.
  Object? workerRequestsResult;
  Object? workerRequestResult;
  Object? workerJobsResult;
  Object? workerJobResult;
  Object? submitQuoteResult;

  /// Make submitQuote STORE the quote and then fail (the server created it but the answer never arrived).
  Exception? submitFailAfterCreating;
  Object? jobActionResult;

  final List<(String, SubmitQuoteRequest)> submittedQuotes = [];
  int _quoteSeq = 0;

  static const _notFound = ApiException(status: 404, code: 'NOT_FOUND', message: 'Not found');

  @override
  Future<PagedList<WorkerRequest>> workerRequests(String accessToken, {int page = 1, int limit = 20, String sort = 'soonest'}) async {
    calls.add('workerRequests');
    final r = workerRequestsResult;
    if (r is Exception) throw r;
    return PagedList(items: List.of(workerRequestList), page: 1, total: workerRequestList.length, totalPages: 1);
  }

  @override
  Future<WorkerRequest> workerRequest(String accessToken, String bookingId) async {
    calls.add('workerRequest');
    final r = workerRequestResult;
    if (r is Exception) throw r;
    return workerRequestList.firstWhere((x) => x.id == bookingId, orElse: () => throw _notFound);
  }

  @override
  Future<WorkerQuote> submitQuote(String accessToken, String bookingId, SubmitQuoteRequest request) async {
    calls.add('submitQuote');
    submittedQuotes.add((bookingId, request));
    final r = submitQuoteResult;
    if (r is Exception) throw r;
    final index = workerRequestList.indexWhere((x) => x.id == bookingId);
    if (index < 0) throw _notFound;
    final target = workerRequestList[index];
    if (target.myQuote != null) {
      throw const ApiException(status: 409, code: 'QUOTE_EXISTS', message: 'You already quoted on this request. Edit your quote instead');
    }
    final price = request.priceHalalas;
    final vat = (price * 0.15).round();
    final commission = (price * 0.15).round();
    final quote = WorkerQuote(
      id: 'quote-${++_quoteSeq}',
      bookingId: bookingId,
      bookingReference: target.reference,
      status: 'SUBMITTED',
      version: 1,
      money: WorkerMoney(
        currency: 'SAR',
        serviceHalalas: price,
        vatHalalas: vat,
        totalHalalas: price + vat,
        vatRateBps: 1500,
        commissionHalalas: commission,
        payoutHalalas: price - commission,
        commissionRateBps: 1500,
      ),
      proposedStartAt: request.proposedStartAt,
      proposedEndAt: request.proposedEndAt,
      estimatedDurationMinutes: request.estimatedDurationMinutes,
      message: request.message,
      validUntil: DateTime.now().toUtc().add(Duration(hours: request.validForHours ?? 24)),
      isExpired: false,
      createdAt: DateTime.now().toUtc(),
    );
    workerQuoteList.insert(0, quote);
    workerRequestList[index] = WorkerRequest(
      id: target.id,
      reference: target.reference,
      status: target.status,
      service: target.service,
      location: target.location,
      isUrgent: target.isUrgent,
      preferredStartAt: target.preferredStartAt,
      preferredEndAt: target.preferredEndAt,
      expiresAt: target.expiresAt,
      myQuote: quote,
      createdAt: target.createdAt,
      problemDescription: target.problemDescription,
      photoCount: target.photoCount,
    );
    final late = submitFailAfterCreating;
    if (late != null) {
      submitFailAfterCreating = null;
      throw late;
    }
    return quote;
  }

  @override
  Future<PagedList<WorkerQuote>> workerQuotes(String accessToken, {List<String>? statuses, int page = 1, int limit = 20}) async {
    calls.add('workerQuotes');
    final items = [
      for (final q in workerQuoteList)
        if (statuses == null || statuses.isEmpty || statuses.contains(q.status)) q,
    ];
    return PagedList(items: items, page: 1, total: items.length, totalPages: 1);
  }

  // ---- my account: notifications, offers, reviews, my name
  final Map<String, MyReview> myReviews = {};
  Object? submitReviewResult; // an Exception
  Object? myReviewResult; // an Exception
  int? lastReviewRating;
  String? lastReviewComment;
  final List<NotificationItem> notificationList = [];
  Object? notificationsResult; // an Exception makes the list fail
  final List<String> readNotifications = [];
  bool readAllCalled = false;
  final List<OfferItem> offerList = [];
  Object? offersResult;
  ReceivedReviews receivedReviewsResult = const ReceivedReviews(count: 0, average: null, items: []);
  Object? updateNameResult; // an Exception, or the name the server saved
  String? lastUpdatedName;

  @override
  Future<PagedList<NotificationItem>> notifications(String accessToken, {int page = 1, int limit = 30}) async {
    calls.add('notifications');
    final r = notificationsResult;
    if (r is Exception) throw r;
    return PagedList(items: List.of(notificationList), page: 1, total: notificationList.length, totalPages: 1);
  }

  @override
  Future<int> unreadNotifications(String accessToken) async {
    calls.add('unreadNotifications');
    final r = notificationsResult;
    if (r is Exception) throw r;
    return notificationList.where((n) => !n.read && !readNotifications.contains(n.id)).length;
  }

  @override
  Future<void> markNotificationRead(String accessToken, String id) async {
    calls.add('markNotificationRead');
    readNotifications.add(id);
  }

  @override
  Future<void> markAllNotificationsRead(String accessToken) async {
    calls.add('markAllNotificationsRead');
    readAllCalled = true;
    readNotifications.addAll(notificationList.map((n) => n.id));
  }

  @override
  Future<List<OfferItem>> offers(String accessToken) async {
    calls.add('offers');
    final r = offersResult;
    if (r is Exception) throw r;
    return List.of(offerList);
  }

  @override
  Future<MyReview?> myReview(String accessToken, String bookingId) async {
    calls.add('myReview');
    final r = myReviewResult;
    if (r is Exception) throw r;
    return myReviews[bookingId];
  }

  @override
  Future<MyReview> submitReview(String accessToken, String bookingId, {required int rating, String? comment}) async {
    calls.add('submitReview');
    lastReviewRating = rating;
    lastReviewComment = comment;
    final r = submitReviewResult;
    if (r is Exception) throw r;
    return myReviews[bookingId] = MyReview(id: 'rv-$bookingId', rating: rating, comment: comment, status: 'PUBLISHED');
  }

  @override
  Future<ReceivedReviews> receivedReviews(String accessToken, {int limit = 10}) async {
    calls.add('receivedReviews');
    return receivedReviewsResult;
  }

  bool workerOnline = true;
  final Map<String, String> cityNames = {};
  Object? onlineResult; // an Exception makes the switch fail

  @override
  Future<bool> setWorkerOnline(String accessToken, bool online) async {
    calls.add('setWorkerOnline');
    final r = onlineResult;
    if (r is Exception) throw r;
    workerOnline = online;
    return online;
  }

  String? lastLocale;
  String? photoUrlResult;

  @override
  Future<void> setLocale(String accessToken, String locale) async {
    calls.add('setLocale');
    lastLocale = locale;
  }

  @override
  Future<String?> workerPhotoUrl(String accessToken) async {
    calls.add('workerPhotoUrl');
    return photoUrlResult;
  }

  @override
  Future<String?> updateCustomerName(String accessToken, String fullName) async {
    calls.add('updateCustomerName');
    lastUpdatedName = fullName;
    final r = updateNameResult;
    if (r is Exception) throw r;
    return r is String ? r : fullName;
  }

  @override
  Future<PagedList<WorkerJob>> workerJobs(String accessToken, {List<String>? statuses, int page = 1, int limit = 20}) async {
    calls.add('workerJobs');
    final r = workerJobsResult;
    if (r is Exception) throw r;
    final items = [
      for (final j in workerJobList)
        if (statuses == null || statuses.isEmpty || statuses.contains(j.status)) j,
    ];
    return PagedList(items: items, page: 1, total: items.length, totalPages: 1);
  }

  @override
  Future<WorkerJob> workerJob(String accessToken, String bookingId) async {
    calls.add('workerJob');
    final r = workerJobResult;
    if (r is Exception) throw r;
    return workerJobList.firstWhere((x) => x.id == bookingId, orElse: () => throw _notFound);
  }

  Future<WorkerJob> _moveJob(String bookingId, String from, String to) async {
    final r = jobActionResult;
    if (r is Exception) throw r;
    final index = workerJobList.indexWhere((x) => x.id == bookingId);
    if (index < 0) throw _notFound;
    final j = workerJobList[index];
    if (j.status != from) {
      throw ApiException(status: 409, code: 'INVALID_TRANSITION', message: 'A ${j.status.toLowerCase()} booking cannot do this');
    }
    final moved = WorkerJob(
      id: j.id,
      reference: j.reference,
      status: to,
      service: j.service,
      location: j.location,
      isUrgent: j.isUrgent,
      preferredStartAt: j.preferredStartAt,
      preferredEndAt: j.preferredEndAt,
      expiresAt: j.expiresAt,
      myQuote: j.myQuote,
      createdAt: j.createdAt,
      problemDescription: j.problemDescription,
      photoCount: j.photoCount,
      money: j.money,
      customerName: j.customerName,
      customerPhone: j.customerPhone,
      paymentMethod: j.paymentMethod,
      cashCollectedAt: j.cashCollectedAt,
      startedAt: to == 'IN_PROGRESS' ? DateTime.now().toUtc() : j.startedAt,
      completedAt: to == 'COMPLETED' ? DateTime.now().toUtc() : j.completedAt,
    );
    workerJobList[index] = moved;
    return moved;
  }

  Object? cashResult;
  final List<String> cashChosen = [];
  final List<String> cashConfirmed = [];

  @override
  Future<BookingDetail> payCash(String accessToken, String bookingId) async {
    calls.add('payCash');
    cashChosen.add(bookingId);
    final r = cashResult;
    if (r is Exception) throw r;
    final d = detailStore[bookingId] ?? (throw _notFound);
    if (d.paymentMethod == 'CASH' && d.status != 'PAYMENT_PENDING') return d; // repeat
    if (d.status != 'PAYMENT_PENDING') {
      throw ApiException(status: 409, code: 'BOOKING_NOT_PAYABLE', message: 'A ${d.status.toLowerCase()} booking cannot be paid');
    }
    final paid = BookingDetail(
      id: d.id,
      reference: d.reference,
      status: 'CONFIRMED',
      serviceNameEn: d.serviceNameEn,
      serviceNameAr: d.serviceNameAr,
      location: d.location,
      isUrgent: d.isUrgent,
      problemDescription: d.problemDescription,
      preferredStartAt: d.preferredStartAt,
      preferredEndAt: d.preferredEndAt,
      expiresAt: d.expiresAt,
      money: d.money,
      worker: AssignedWorker(
        workerId: d.worker?.workerId ?? '',
        fullName: d.worker?.fullName,
        fullNameAr: d.worker?.fullNameAr,
        phone: '+966500000001',
      ),
      acceptedQuoteId: d.acceptedQuoteId,
      paymentMethod: 'CASH',
    );
    detailStore[bookingId] = paid;
    return paid;
  }

  @override
  Future<WorkerJob> confirmCashCollected(String accessToken, String bookingId) async {
    calls.add('confirmCashCollected');
    cashConfirmed.add(bookingId);
    final r = jobActionResult;
    if (r is Exception) throw r;
    final index = workerJobList.indexWhere((x) => x.id == bookingId);
    if (index < 0) throw _notFound;
    final j = workerJobList[index];
    if (!j.isCash) throw const ApiException(status: 409, code: 'NOT_A_CASH_BOOKING', message: 'This booking is not paid in cash');
    if (j.cashCollectedAt != null) return j;
    if (j.status != 'IN_PROGRESS' && j.status != 'COMPLETED') {
      throw ApiException(status: 409, code: 'CASH_NOT_DUE_YET', message: 'Cash can be confirmed once the work has started (${j.status})');
    }
    final moved = WorkerJob(
      id: j.id,
      reference: j.reference,
      status: j.status,
      service: j.service,
      location: j.location,
      isUrgent: j.isUrgent,
      preferredStartAt: j.preferredStartAt,
      preferredEndAt: j.preferredEndAt,
      expiresAt: j.expiresAt,
      myQuote: j.myQuote,
      createdAt: j.createdAt,
      problemDescription: j.problemDescription,
      photoCount: j.photoCount,
      money: j.money,
      customerName: j.customerName,
      customerPhone: j.customerPhone,
      paymentMethod: j.paymentMethod,
      cashCollectedAt: DateTime.now().toUtc(),
      startedAt: j.startedAt,
      completedAt: j.completedAt,
    );
    workerJobList[index] = moved;
    return moved;
  }

  @override
  Future<WorkerJob> startWorkerJob(String accessToken, String bookingId) {
    calls.add('startWorkerJob');
    return _moveJob(bookingId, 'CONFIRMED', 'IN_PROGRESS');
  }

  @override
  Future<WorkerJob> completeWorkerJob(String accessToken, String bookingId) {
    calls.add('completeWorkerJob');
    return _moveJob(bookingId, 'IN_PROGRESS', 'COMPLETED');
  }

  @override
  Future<Catalog> catalog() async {
    _maybeFail('catalog');
    return catalogResult;
  }

  @override
  Future<WorkerOnboarding> workerOnboarding(String accessToken) async {
    _maybeFail('workerOnboarding');
    return _onboarding();
  }

  @override
  Future<WorkerOnboarding> updateWorkerProfile(
    String accessToken, {
    String? fullName,
    String? fullNameAr,
    String? bio,
    int? yearsOfExperience,
  }) async {
    _maybeFail('updateWorkerProfile');
    if (fullName != null && fullName.trim().length < 2) {
      throw const ApiException(status: 400, code: 'HTTP_400', fieldMessages: ['fullName must be longer than or equal to 2 characters']);
    }
    this.fullName = fullName ?? this.fullName;
    this.fullNameAr = fullNameAr ?? this.fullNameAr;
    this.bio = bio ?? this.bio;
    this.yearsOfExperience = yearsOfExperience ?? this.yearsOfExperience;
    return _onboarding();
  }

  @override
  Future<WorkerOnboarding> setWorkerServices(String accessToken, List<String> serviceIds) async {
    _maybeFail('setWorkerServices');
    workerServices
      ..clear()
      ..addAll(serviceIds);
    return _onboarding();
  }

  @override
  Future<WorkerOnboarding> setWorkerAreas(String accessToken, List<String> cityIds) async {
    _maybeFail('setWorkerAreas');
    workerCities
      ..clear()
      ..addAll(cityIds);
    return _onboarding();
  }

  @override
  Future<WorkerOnboarding> setWorkerAvailability(String accessToken, List<AvailabilityWindow> windows) async {
    _maybeFail('setWorkerAvailability');
    workerWindows = List.of(windows);
    return _onboarding();
  }

  @override
  Future<DocumentUploadTicket> registerWorkerDocument(
    String accessToken, {
    required DocumentKind kind,
    required String fileName,
    required String mimeType,
    required int sizeBytes,
    String? expiresOn,
  }) async {
    _maybeFail('registerWorkerDocument'); // for example a 503 DOCUMENT_STORAGE_NOT_CONFIGURED: nothing is created then
    final id = 'doc-${++_docSeq}';
    final doc = {
      'id': id,
      'type': kind.wire,
      'status': 'PENDING_UPLOAD',
      'fileName': fileName,
      'mimeType': mimeType,
      'sizeBytes': sizeBytes,
      'expiresOn': expiresOn,
      'reviewNote': null,
      'scanStatus': 'NOT_SCANNED',
      'createdAt': '2026-11-01T10:00:00.000Z',
    };
    workerDocuments.add(doc);
    return DocumentUploadTicket.fromJson({
      'document': doc,
      'uploadUrl': 'https://storage.example.invalid/upload/$id?sig=secret',
      'method': 'PUT',
      'headers': {'Content-Type': mimeType},
      'expiresAt': '2026-11-01T10:15:00.000Z',
    });
  }

  @override
  Future<void> uploadToSignedUrl(DocumentUploadTicket ticket, Uint8List bytes) async {
    _maybeFail('uploadToSignedUrl');
    signedUploads++;
    lastUploadUrl = ticket.uploadUrl;
    lastUploadHeaders = ticket.headers;
  }

  @override
  Future<WorkerDocument> confirmWorkerDocument(String accessToken, String documentId) async {
    _maybeFail('confirmWorkerDocument');
    final doc = workerDocuments.firstWhere((d) => d['id'] == documentId);
    doc['status'] = 'UPLOADED';
    doc['scanStatus'] = scanOnConfirm;
    return WorkerDocument.fromJson(doc);
  }

  @override
  Future<void> deleteWorkerDocument(String accessToken, String documentId) async {
    _maybeFail('deleteWorkerDocument');
    workerDocuments.removeWhere((d) => d['id'] == documentId);
  }

  @override
  Future<VerificationInfo> workerVerification(String accessToken) async {
    _maybeFail('workerVerification');
    return VerificationInfo.fromJson(_verificationJson());
  }

  @override
  Future<VerificationInfo> submitWorkerVerification(String accessToken) async {
    _maybeFail('submitWorkerVerification');
    if (!_submittable) throw const ApiException(status: 409, code: 'INVALID_STATE');
    final missing = _missing();
    if (missing.isNotEmpty) throw ApiException(status: 409, code: 'VERIFICATION_INCOMPLETE', details: {'missing': missing});
    workerStatus = 'SUBMITTED';
    reviewerNote = null;
    return VerificationInfo.fromJson(_verificationJson());
  }
}

class FakePhone implements PhoneAuthGateway {
  final List<String> calls = [];
  Object sendResult = const CodeSent(verificationId: 'verification-1', resendToken: 7, timeout: Duration(seconds: 60));
  Object confirmResult = 'firebase-id-token-1'; // String or Exception
  String? lastPhone;
  int? lastResendToken;
  String? lastLanguage;
  String? lastCode;
  final StreamController<String> auto = StreamController<String>.broadcast();

  @override
  Stream<String> get autoVerifiedTokens => auto.stream;

  @override
  Future<PhoneCodeResult> sendCode({required String phoneE164, int? resendToken, String? languageCode}) async {
    calls.add('sendCode');
    lastPhone = phoneE164;
    lastResendToken = resendToken;
    lastLanguage = languageCode;
    final r = sendResult;
    if (r is Exception) throw r;
    return r as PhoneCodeResult;
  }

  @override
  Future<String> confirmCode({required String verificationId, required String smsCode}) async {
    calls.add('confirmCode');
    lastCode = smsCode;
    final r = confirmResult;
    if (r is Exception) throw r;
    return r as String;
  }

  @override
  Future<void> signOut() async => calls.add('firebaseSignOut');
}

class FakePush implements PushGateway {
  bool permission = true;
  String? token = 'fcm-token-1';
  bool deleted = false;
  Object? deleteResult; // an Exception to fail the deletion
  Duration deleteDelay = Duration.zero;
  final StreamController<String> refresh = StreamController<String>.broadcast();
  final StreamController<PushEvent> foregroundEvents = StreamController<PushEvent>.broadcast();
  final StreamController<PushEvent> openedEvents = StreamController<PushEvent>.broadcast();

  /// The push whose tap started the app, if any.
  PushEvent? startedBy;

  @override
  Stream<PushEvent> get onForeground => foregroundEvents.stream;

  @override
  Stream<PushEvent> get onOpened => openedEvents.stream;

  @override
  Future<PushEvent?> initialOpened() async => startedBy;

  @override
  Future<bool> requestPermission() async => permission;

  @override
  Future<String?> getToken() async => token;

  @override
  Stream<String> get onTokenRefresh => refresh.stream;

  @override
  Future<void> deleteToken() async {
    if (deleteDelay != Duration.zero) await Future<void>.delayed(deleteDelay);
    final r = deleteResult;
    if (r is Exception) throw r;
    deleted = true;
  }
}

class Clock {
  Clock([DateTime? start]) : now = start ?? DateTime.utc(2026, 11, 1, 10);
  DateTime now;
  DateTime call() => now;
}

/// A complete client built from the doubles above. By default a backend sign-in succeeds with a customer session.
class TestHsClient {
  TestHsClient({AppKind kind = AppKind.customer, AuthUser? user}) {
    api.signInResult = fakeSession(
      user: user ?? fakeUser(role: kind == AppKind.worker ? 'WORKER' : 'CUSTOMER'),
      accessExpiresAt: DateTime.now().add(const Duration(hours: 1)),
    );
    final store = SessionStore(kv);
    final auth = AuthController(api: api, store: store, phone: phone, kind: kind);
    final pushService = PushService(api: api, gateway: push, auth: auth, store: store, platform: () => 'ANDROID');
    client = HsClient(api: api, auth: auth, push: pushService, store: store);
  }

  final api = FakeApi();
  final phone = FakePhone();
  final push = FakePush();
  final kv = MemoryKeyValueStore();
  late final HsClient client;
}
