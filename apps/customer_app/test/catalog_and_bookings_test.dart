import 'package:customer_app/core/constants/icon_paths.dart';
import 'package:customer_app/features/bookings/my_bookings_controller.dart';
import 'package:customer_app/features/bookings/widgets/real_bookings_view.dart';
import 'package:customer_app/features/catalog/catalog_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

/// The services and cities the booking flow offers come from the backend catalog; the customer's own bookings come from `GET /bookings`.
void main() {
  group('catalog', () {
    late TestHsClient kit;
    late CatalogController catalog;

    setUp(() {
      kit = TestHsClient();
      catalog = CatalogController(load: kit.api.catalog);
      addTearDown(() {
        catalog.dispose();
        kit.client.auth.dispose();
      });
    });

    test(
      'services carry the backend ids, not prototype ids, and invent no price, rating or duration',
      () async {
        expect(catalog.status, CatalogStatus.idle);
        await catalog.load();

        expect(catalog.status, CatalogStatus.ready);
        final ids = catalog.services.map((s) => s.id).toList();
        expect(ids, ['svc-ac', 'svc-plumb']);
        expect(ids, isNot(contains('acdeep')));
        for (final s in catalog.services) {
          expect(s.price, isNull);
          expect(s.was, isNull);
          expect(s.rating, isNull);
          expect(s.reviews, isNull);
          expect(s.duration, isNull);
          expect(s.ribbon, isNull);
          expect(
            kIconPaths.containsKey(s.icon),
            isTrue,
            reason: 'icon ${s.icon} must exist',
          );
        }
        expect(catalog.services.first.name.en, 'AC repair');
        expect(catalog.services.first.name.ar, 'إصلاح المكيفات');
        expect(catalog.services.first.category, 'cat-1');
      },
    );

    test('cities and categories come from the backend', () async {
      await catalog.load();
      expect(catalog.cities.map((c) => c.id), ['city-ruh', 'city-jed']);
      expect(catalog.cities.first.name(arabic: true), 'الرياض');
      expect(catalog.categories.single.id, 'cat-1');
      expect(catalog.categories.single.name.en, 'Home repair');
    });

    test(
      'a service is found by id, and an unknown or prototype id is not found',
      () async {
        await catalog.load();
        expect(catalog.serviceById('svc-plumb')!.name.en, 'Plumbing');
        expect(catalog.serviceById('acdeep'), isNull);
        expect(catalog.serviceById(null), isNull);
      },
    );

    test('a category without services is not offered', () async {
      kit.api.catalogResult = const Catalog(
        categories: [
          CatalogCategory(
            id: 'empty',
            nameEn: 'Empty',
            nameAr: 'فارغ',
            services: [],
          ),
          CatalogCategory(
            id: 'cat-x',
            nameEn: 'Cooling',
            nameAr: 'تكييف',
            services: [
              CatalogService(
                id: 's1',
                categoryId: 'cat-x',
                nameEn: 'AC clean',
                nameAr: '',
              ),
            ],
          ),
        ],
        cities: [],
      );
      await catalog.load();
      expect(catalog.categories.map((c) => c.id), ['cat-x']);
      expect(
        catalog.services.single.name.ar,
        'AC clean',
        reason: 'a missing Arabic name falls back to English',
      );
      expect(catalog.cities, isEmpty);
    });

    test(
      'failure is reported, a retry recovers, and loading twice at once makes one request',
      () async {
        kit.api.failures['catalog'] = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await catalog.load();
        expect(catalog.status, CatalogStatus.failed);
        expect(catalog.error!.isNetwork, isTrue);
        expect(catalog.services, isEmpty);

        final a = catalog.load();
        final b = catalog.load();
        await Future.wait([a, b]);
        expect(catalog.status, CatalogStatus.ready);
        expect(
          kit.api.onboardingCalls.where((c) => c == 'catalog'),
          hasLength(2),
          reason: 'one failed attempt plus one shared retry',
        );
      },
    );

    test(
      'once loaded it is not fetched again; a refresh that fails keeps what was loaded',
      () async {
        await catalog.load();
        await catalog.load();
        expect(
          kit.api.onboardingCalls.where((c) => c == 'catalog'),
          hasLength(1),
        );

        kit.api.failures['catalog'] = const ApiException(
          status: 503,
          code: 'UNAVAILABLE',
        );
        await catalog.load(force: true);
        expect(catalog.status, CatalogStatus.ready);
        expect(catalog.error, isNotNull);
        expect(catalog.services, hasLength(2));
      },
    );

    test(
      'a category icon the app has is used; otherwise one is chosen from the name, and always one that exists',
      () async {
        kit.api.catalogResult = const Catalog(
          categories: [
            CatalogCategory(
              id: 'a',
              nameEn: 'Electrical',
              nameAr: 'كهرباء',
              slug: 'electrical',
              services: [
                CatalogService(
                  id: '1',
                  categoryId: 'a',
                  nameEn: 'x',
                  nameAr: 'x',
                ),
              ],
            ),
            CatalogCategory(
              id: 'b',
              nameEn: 'Whatever',
              nameAr: 'x',
              iconKey: 'not-an-icon',
              services: [
                CatalogService(
                  id: '2',
                  categoryId: 'b',
                  nameEn: 'y',
                  nameAr: 'y',
                ),
              ],
            ),
            CatalogCategory(
              id: 'c',
              nameEn: 'Any',
              nameAr: 'x',
              iconKey: 'droplet',
              services: [
                CatalogService(
                  id: '3',
                  categoryId: 'c',
                  nameEn: 'z',
                  nameAr: 'z',
                ),
              ],
            ),
          ],
          cities: [],
        );
        await catalog.load();
        final icons = {for (final s in catalog.services) s.id: s.icon};
        expect(icons['1'], 'zap');
        expect(icons['2'], 'wrench');
        expect(icons['3'], 'droplet');
      },
    );
  });

  group('my bookings', () {
    late TestHsClient kit;
    late MyBookingsController list;

    Future<void> seed(int n) async {
      for (var i = 0; i < n; i++) {
        await kit.api.createBooking(
          'token',
          CreateBookingRequest(
            serviceId: 'svc-ac',
            cityId: 'city-ruh',
            problemDescription: 'Problem number $i',
            preferredStartAt: DateTime.utc(2026, 11, 3, 10 + i),
            preferredEndAt: DateTime.utc(2026, 11, 3, 12 + i),
            isUrgent: false,
            locationFields: const {
              'addressLine': 'Somewhere',
              'latitude': 24.7,
              'longitude': 46.6,
            },
          ),
        );
      }
    }

    setUp(() async {
      kit = TestHsClient();
      await kit.client.auth.sendCode('+966551234567');
      await kit.client.auth.submitCode('123456');
      list = MyBookingsController(api: kit.api, auth: kit.client.auth);
      addTearDown(() {
        list.dispose();
        kit.client.auth.dispose();
      });
    });

    test('loads the signed-in customer\'s bookings', () async {
      await seed(2);
      expect(list.status, MyBookingsStatus.idle);
      await list.load();
      expect(list.status, MyBookingsStatus.ready);
      expect(list.items.map((b) => b.reference).toSet(), {'HS-1', 'HS-2'});
      expect(list.items.first.status, 'OPEN');
    });

    test(
      'an empty account is "ready" with nothing in it, not an error',
      () async {
        await list.load();
        expect(list.status, MyBookingsStatus.ready);
        expect(list.items, isEmpty);
        expect(list.error, isNull);
      },
    );

    test(
      'a first load that fails is "failed"; a later refresh that fails keeps the list',
      () async {
        kit.api.myBookingsResult = const ApiException(
          status: 0,
          code: 'NETWORK',
        );
        await list.load();
        expect(list.status, MyBookingsStatus.failed);
        expect(list.error!.isNetwork, isTrue);

        kit.api.myBookingsResult = null;
        await seed(1);
        await list.load();
        expect(list.status, MyBookingsStatus.ready);
        expect(list.error, isNull);
        expect(list.items, hasLength(1));

        kit.api.myBookingsResult = const ApiException(
          status: 503,
          code: 'UNAVAILABLE',
        );
        await list.load();
        expect(list.status, MyBookingsStatus.ready);
        expect(list.error, isNotNull);
        expect(list.items, hasLength(1), reason: 'what we had stays visible');
      },
    );

    test('overlapping loads share one request', () async {
      await Future.wait([list.load(), list.load(), list.load()]);
      expect(kit.api.calls.where((c) => c == 'myBookings'), hasLength(1));
    });

    test('clear forgets the list (sign-out)', () async {
      await seed(1);
      await list.load();
      list.clear();
      expect(list.items, isEmpty);
      expect(list.status, MyBookingsStatus.idle);
    });

    test(
      'every backend state lands on a tab; unknown ones stay in "upcoming"',
      () {
        expect(bookingTabFor('OPEN'), 0);
        expect(bookingTabFor('PAYMENT_PENDING'), 0);
        expect(bookingTabFor('CONFIRMED'), 0);
        expect(bookingTabFor('IN_PROGRESS'), 1);
        expect(bookingTabFor('COMPLETED'), 2);
        expect(bookingTabFor('CANCELLED'), 3);
        expect(bookingTabFor('EXPIRED'), 3);
        expect(bookingTabFor('SOMETHING_NEW'), 0);
      },
    );
  });
}
