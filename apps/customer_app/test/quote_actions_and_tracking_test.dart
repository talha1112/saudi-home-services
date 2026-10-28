import 'dart:typed_data';

import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/core/config/demo_data.dart';
import 'package:customer_app/features/booking/logic/picked_photo.dart';
import 'package:customer_app/features/booking/widgets/details_step.dart';
import 'package:customer_app/features/bookings/screens/booking_detail_screen.dart';
import 'package:customer_app/features/bookings/widgets/tracking_status.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

import 'support/booking_harness.dart';

/// Rejecting a quote, asking for a change, the live status with its ETA, cancelling, and attaching photos: through the real screens on the
/// shared fake backend.
const _money = CustomerMoney(
  currency: 'SAR',
  serviceHalalas: 25000,
  vatHalalas: 3750,
  totalHalalas: 28750,
  vatRateBps: 1500,
);

BookingDetail _booking({
  String status = 'OPEN',
  DateTime? arrivedAt,
  List<BookingEvent> timeline = const [],
}) => BookingDetail(
  id: 'b-1',
  reference: 'HS-1',
  status: status,
  serviceNameEn: 'AC repair',
  serviceNameAr: 'إصلاح',
  location: const BookingLocation(
    cityId: 'c',
    addressLine: 'King Fahd Rd',
    latitude: 24.7200,
    longitude: 46.6800,
  ),
  isUrgent: false,
  problemDescription: 'Weak cooling',
  money: status == 'OPEN' ? null : _money,
  worker: status == 'OPEN'
      ? null
      : const AssignedWorker(
          workerId: 'w',
          fullName: 'Faisal',
          phone: '+966500000001',
        ),
  acceptedQuoteId: status == 'OPEN' ? null : 'q-1',
  paymentMethod: status == 'OPEN' ? null : 'CASH',
  arrivedAt: arrivedAt,
  timeline: timeline,
);

CustomerQuote _quote() => CustomerQuote(
  id: 'q-1',
  bookingId: 'b-1',
  status: 'SUBMITTED',
  version: 1,
  money: _money,
  worker: const QuoteWorker(
    workerId: 'w',
    fullName: 'Faisal',
    fullNameAr: 'فيصل',
  ),
  isExpired: false,
  validUntil: DateTime.now().toUtc().add(const Duration(hours: 20)),
);

Widget _fakeMap(LatLng worker, LatLng? destination) => Container(
  key: Key('fake-map-${worker.latitude},${worker.longitude}'),
  color: const Color(0xFFE4ECE9),
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

Future<TestHsClient> _open(
  WidgetTester tester,
  BookingDetail booking, {
  void Function(FakeApi)? arrange,
}) async {
  phoneSize(tester, height: 2200);
  final kit = TestHsClient();
  await signIn(kit);
  kit.api.detailStore['b-1'] = booking;
  kit.api.customerQuoteList.add(_quote());
  arrange?.call(kit.api);
  final services = makeServices(kit);
  addTearDown(() {
    services.catalog.dispose();
    services.submitter.dispose();
    services.bookings.dispose();
    kit.client.auth.dispose();
  });
  await tester.pumpWidget(
    harness(
      kit: kit,
      services: services,
      state: AppState(),
      home: BookingDetailScreen(
        bookingId: 'b-1',
        mapBuilder: _fakeMap,
        mapsEnabled: true,
      ),
    ),
  );
  await _settle(tester);
  return kit;
}

void main() {
  test(
    'the ETA is an estimate from the straight line, and absent without both points',
    () {
      expect(etaMinutes(null, const LatLng(24.7, 46.7)), isNull);
      expect(etaMinutes(const LatLng(24.7, 46.7), null), isNull);
      expect(etaMinutes(const LatLng(24.7, 46.7), const LatLng(24.7, 46.7)), 1);
      final m = etaMinutes(
        const LatLng(24.7136, 46.6753),
        const LatLng(24.7936, 46.6753),
      )!;
      expect(m, inInclusiveRange(15, 25)); // about 9 km
    },
  );

  test('the stage comes from what the server reports', () {
    expect(trackingStage(_booking(status: 'CONFIRMED'), sharing: false), 2);
    expect(trackingStage(_booking(status: 'CONFIRMED'), sharing: true), 3);
    expect(
      trackingStage(
        _booking(status: 'CONFIRMED', arrivedAt: DateTime.now()),
        sharing: true,
      ),
      4,
    );
    expect(trackingStage(_booking(status: 'IN_PROGRESS'), sharing: true), 5);
    expect(trackingStage(_booking(status: 'COMPLETED'), sharing: false), 6);
  });

  if (kDemoData) return;
  setUpAll(loadAppFonts);

  group('quotes', () {
    testWidgets('Reject asks first, then rejects only that quote', (
      tester,
    ) async {
      final kit = await _open(tester, _booking());
      expect(find.byKey(const Key('reject-q-1')), findsOneWidget);
      expect(find.byKey(const Key('change-q-1')), findsOneWidget);
      await tester.tap(find.byKey(const Key('reject-q-1')));
      await _settle(tester);
      expect(find.byKey(const Key('reject-dialog')), findsOneWidget);
      expect(kit.api.rejectedQuotes, isEmpty);
      await tester.tap(find.byKey(const Key('reject-confirm')));
      await _settle(tester);
      expect(kit.api.rejectedQuotes.single, ('b-1', 'q-1'));
      expect(find.byKey(const Key('accept-q-1')), findsNothing);
      expect(find.byKey(const Key('no-quotes')), findsOneWidget);
    });

    testWidgets('declining the reject confirmation rejects nothing', (
      tester,
    ) async {
      final kit = await _open(tester, _booking());
      await tester.tap(find.byKey(const Key('reject-q-1')));
      await _settle(tester);
      await tester.tap(find.text('Not now'));
      await _settle(tester);
      expect(kit.api.rejectedQuotes, isEmpty);
      expect(find.byKey(const Key('accept-q-1')), findsOneWidget);
    });

    testWidgets(
      'Request change needs a message, sends it, and shows it on the quote',
      (tester) async {
        final kit = await _open(tester, _booking());
        await tester.tap(find.byKey(const Key('change-q-1')));
        await _settle(tester);
        await tester.tap(find.byKey(const Key('change-send')));
        await _settle(tester);
        expect(find.text('Write at least 3 characters.'), findsOneWidget);
        expect(kit.api.changeRequests, isEmpty);
        await tester.enterText(
          find.byKey(const Key('change-input')),
          'Please come earlier',
        );
        await tester.tap(find.byKey(const Key('change-send')));
        await _settle(tester);
        expect(kit.api.changeRequests.single, (
          'b-1',
          'q-1',
          'Please come earlier',
        ));
        expect(find.byKey(const Key('change-sent-q-1')), findsOneWidget);
        expect(
          find.byKey(const Key('accept-q-1')),
          findsOneWidget,
          reason: 'the quote can still be chosen',
        );
      },
    );

    testWidgets('a refused rejection says so and keeps the quote', (
      tester,
    ) async {
      final kit = await _open(
        tester,
        _booking(),
        arrange: (api) => api.quoteActionResult = const ApiException(
          status: 409,
          code: 'QUOTE_NOT_AVAILABLE',
          message: 'no',
        ),
      );
      await tester.tap(find.byKey(const Key('reject-q-1')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('reject-confirm')));
      await _settle(tester);
      expect(kit.api.rejectedQuotes, hasLength(1));
      expect(find.byKey(const Key('detail-error')), findsOneWidget);
    });
  });

  group('live status and cancelling', () {
    final timeline = [
      BookingEvent(
        type: 'BOOKING_CREATED',
        createdAt: DateTime.utc(2026, 11, 1, 14, 30),
      ),
      BookingEvent(
        type: 'QUOTE_ACCEPTED',
        createdAt: DateTime.utc(2026, 11, 1, 14, 31),
      ),
      BookingEvent(
        type: 'PAYMENT_CONFIRMED',
        createdAt: DateTime.utc(2026, 11, 1, 14, 33),
      ),
    ];

    testWidgets(
      'a professional on the way shows the status, the ETA and the timeline',
      (tester) async {
        await _open(
          tester,
          _booking(status: 'CONFIRMED', timeline: timeline),
          arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
            latitude: 24.7136,
            longitude: 46.6753,
            ageSeconds: 3,
          ),
        );
        expect(find.byKey(const Key('tracking-status')), findsOneWidget);
        expect(find.text('On the way'), findsWidgets);
        expect(find.byKey(const Key('tracking-eta')), findsOneWidget);
        expect(find.text('5:30 PM'), findsOneWidget); // Saudi time
        expect(find.byKey(const Key('cancel-booking')), findsOneWidget);
      },
    );

    testWidgets(
      'without a shared position the status is "Professional accepted" and there is no ETA',
      (tester) async {
        await _open(tester, _booking(status: 'CONFIRMED', timeline: timeline));
        expect(find.byKey(const Key('tracking-eta')), findsNothing);
        expect(find.text('Professional accepted'), findsWidgets);
      },
    );

    testWidgets(
      'after arriving the stage is Arrived, and an ETA is no longer shown',
      (tester) async {
        await _open(
          tester,
          _booking(
            status: 'CONFIRMED',
            arrivedAt: DateTime.utc(2026, 11, 1, 15),
            timeline: timeline,
          ),
          arrange: (api) => api.positions['b-1'] = const LiveLocation.at(
            latitude: 24.7136,
            longitude: 46.6753,
            ageSeconds: 3,
          ),
        );
        expect(find.text('Arrived'), findsWidgets);
        expect(find.byKey(const Key('tracking-eta')), findsNothing);
      },
    );

    testWidgets('Cancel asks for a reason, then cancels through the server', (
      tester,
    ) async {
      final kit = await _open(
        tester,
        _booking(status: 'CONFIRMED', timeline: timeline),
      );
      await tester.ensureVisible(find.byKey(const Key('cancel-booking')));
      await tester.tap(find.byKey(const Key('cancel-booking')));
      await _settle(tester);
      expect(find.byKey(const Key('cancel-sheet')), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-reason-PRICE_TOO_HIGH')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('cancel-confirm')));
      await _settle(tester);
      expect(kit.api.cancelledBookings.single, ('b-1', 'PRICE_TOO_HIGH', null));
      expect(find.byKey(const Key('cancel-sheet')), findsNothing);
      expect(find.text('Cancelled'), findsWidgets);
      expect(find.byKey(const Key('cancel-booking')), findsNothing);
    });

    testWidgets(
      'keeping the booking cancels nothing; a refused cancel says so',
      (tester) async {
        final kit = await _open(
          tester,
          _booking(status: 'CONFIRMED', timeline: timeline),
        );
        await tester.ensureVisible(find.byKey(const Key('cancel-booking')));
        await tester.tap(find.byKey(const Key('cancel-booking')));
        await _settle(tester);
        await tester.tap(find.byKey(const Key('cancel-keep')));
        await _settle(tester);
        expect(kit.api.cancelledBookings, isEmpty);

        kit.api.quoteActionResult = const ApiException(
          status: 409,
          code: 'INVALID_STATE',
          message: 'started',
        );
        await tester.tap(find.byKey(const Key('cancel-booking')));
        await _settle(tester);
        await tester.tap(find.byKey(const Key('cancel-confirm')));
        await _settle(tester);
        expect(find.byKey(const Key('cancel-error')), findsOneWidget);
        expect(find.byKey(const Key('cancel-sheet')), findsOneWidget);
      },
    );

    testWidgets('no cancel once the work has started', (tester) async {
      await _open(tester, _booking(status: 'IN_PROGRESS', timeline: timeline));
      expect(find.byKey(const Key('cancel-booking')), findsNothing);
      expect(find.text('Service in progress'), findsWidgets);
    });
  });

  group('photos', () {
    test(
      'every chosen photo is registered, uploaded and confirmed; a failing one is counted and the rest still go',
      () async {
        final kit = TestHsClient();
        await signIn(kit);
        final services = makeServices(kit);
        addTearDown(() {
          services.catalog.dispose();
          services.submitter.dispose();
          services.bookings.dispose();
          kit.client.auth.dispose();
        });
        final photos = [
          for (var i = 0; i < 3; i++)
            PickedPhoto(
              name: 'p$i.jpg',
              mimeType: 'image/jpeg',
              bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF, i]),
            ),
        ];
        final failed = await services.submitter.attachPhotos('b-1', photos);
        expect(failed, 0);
        expect(kit.api.registeredPhotos.map((p) => p.$2), [
          'p0.jpg',
          'p1.jpg',
          'p2.jpg',
        ]);
        expect(kit.api.photoUploadSizes, [4, 4, 4]);
        expect(kit.api.confirmedPhotos, hasLength(3));

        kit.api.photoResult = const ApiException(
          status: 503,
          code: 'DOCUMENT_STORAGE_NOT_CONFIGURED',
        );
        expect(await services.submitter.attachPhotos('b-1', photos), 3);
      },
    );

    testWidgets(
      'the details step adds several photos, shows them, and removes one',
      (tester) async {
        phoneSize(tester, height: 1400);
        final kit = TestHsClient();
        await signIn(kit);
        final services = makeServices(kit);
        addTearDown(() {
          services.catalog.dispose();
          services.submitter.dispose();
          services.bookings.dispose();
          kit.client.auth.dispose();
        });
        // a 1x1 PNG
        final png = Uint8List.fromList([
          0x89,
          0x50,
          0x4E,
          0x47,
          0x0D,
          0x0A,
          0x1A,
          0x0A,
          0x00,
          0x00,
          0x00,
          0x0D,
          0x49,
          0x48,
          0x44,
          0x52,
          0x00,
          0x00,
          0x00,
          0x01,
          0x00,
          0x00,
          0x00,
          0x01,
          0x08,
          0x06,
          0x00,
          0x00,
          0x00,
          0x1F,
          0x15,
          0xC4,
          0x89,
          0x00,
          0x00,
          0x00,
          0x0D,
          0x49,
          0x44,
          0x41,
          0x54,
          0x78,
          0x9C,
          0x63,
          0xF8,
          0xFF,
          0xFF,
          0x3F,
          0x00,
          0x05,
          0xFE,
          0x02,
          0xFE,
          0xDC,
          0xCC,
          0x59,
          0xE7,
          0x00,
          0x00,
          0x00,
          0x00,
          0x49,
          0x45,
          0x4E,
          0x44,
          0xAE,
          0x42,
          0x60,
          0x82,
        ]);
        final saved = PhotoPicking.pick;
        addTearDown(() => PhotoPicking.pick = saved);
        final asked = <int>[];
        final sources = <PhotoSource>[];
        PhotoPicking.pick = (limit, source) async {
          asked.add(limit);
          sources.add(source);
          return PhotoPick([
            for (var i = 0; i < 2; i++)
              PickedPhoto(name: 'a$i.png', mimeType: 'image/png', bytes: png),
          ]);
        };
        final state = AppState();
        await tester.pumpWidget(
          harness(
            kit: kit,
            services: services,
            state: state,
            home: const Scaffold(
              body: SingleChildScrollView(child: DetailsStep()),
            ),
          ),
        );
        await tester.tap(find.byKey(const Key('photo-add')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('photo-source-camera')), findsOneWidget);
        await tester.tap(find.byKey(const Key('photo-source-gallery')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('photo-add')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('photo-source-camera')));
        await tester.pumpAndSettle();
        expect(sources, [PhotoSource.gallery, PhotoSource.camera]);
        expect(state.photos, hasLength(4));
        await tester.tap(find.byKey(const Key('photo-remove')).first);
        await tester.pump();
        expect(state.photos, hasLength(3));
        state.update(() => state.photos.add(state.photos.first));
        state.update(() => state.photos.add(state.photos.first));
        await tester.pump();
        expect(
          find.byKey(const Key('photo-add')),
          findsNothing,
          reason: 'five is the limit',
        );
      },
    );

    test('the type comes from the first bytes, never the name', () {
      expect(
        PhotoPicking.sniff(Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0])),
        'image/jpeg',
      );
      expect(
        PhotoPicking.sniff(Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D])),
        'image/png',
      );
      expect(
        PhotoPicking.sniff(Uint8List.fromList([0x47, 0x49, 0x46, 0x38, 0x39])),
        isNull,
      );
    });
  });
}
