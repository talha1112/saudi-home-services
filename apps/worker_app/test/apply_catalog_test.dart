import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/features/verification/widgets/apply_form.dart';
import 'package:worker_app/features/verification/widgets/apply_steps.dart';

import 'support/worker_harness.dart';

/// Step 2 of the application offers what the server's catalog has. A catalog with nothing in it (a new server whose services have not been
/// added yet) must say so and offer another try, not show two bare questions.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

Future<TestHsClient> _open(WidgetTester tester, {Catalog? catalog}) async {
  tester.view.physicalSize = const Size(390 * 3, 1200 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final kit = TestHsClient(
    kind: AppKind.worker,
    user: fakeUser(role: 'WORKER', workerStatus: 'NOT_SUBMITTED'),
  );
  await signInWorker(kit);
  if (catalog != null) kit.api.catalogResult = catalog;
  final services = makeJobsServices(kit);
  addTearDown(() {
    services.jobs.dispose();
    services.quotes.dispose();
    services.notifications.dispose();
    services.reviews.dispose();
    kit.client.auth.dispose();
  });
  await kit.client.onboarding.loadCatalog();
  await tester.pumpWidget(
    workerHarness(
      kit: kit,
      services: services,
      state: AppState(),
      home: Scaffold(
        body: SingleChildScrollView(child: ServicesStep(draft: ApplyDraft())),
      ),
    ),
  );
  await _settle(tester);
  return kit;
}

void main() {
  setUpAll(loadWorkerFonts);

  testWidgets(
    'with a filled catalog the services and cities are offered as choices',
    (tester) async {
      await _open(tester);
      expect(find.byKey(const Key('service-svc-ac')), findsOneWidget);
      expect(find.byKey(const Key('city-city-ruh')), findsOneWidget);
      expect(find.byKey(const Key('no-services')), findsNothing);
      expect(find.byKey(const Key('no-cities')), findsNothing);
    },
  );

  testWidgets(
    'an empty catalog says nothing is available yet, and Try again picks up what was added since',
    (tester) async {
      final kit = await _open(
        tester,
        catalog: const Catalog(categories: [], cities: []),
      );
      expect(find.byKey(const Key('no-services')), findsOneWidget);
      expect(find.byKey(const Key('no-cities')), findsOneWidget);
      expect(
        find.text('No services are available yet. Please try again later.'),
        findsOneWidget,
      );
      expect(
        find.text('No cities are available yet. Please try again later.'),
        findsOneWidget,
      );

      // the administrators add the catalog; the worker asks again
      kit.api.catalogResult = const Catalog(
        categories: [
          CatalogCategory(
            id: 'cat-1',
            nameEn: 'Home repair',
            nameAr: 'إصلاح',
            services: [
              CatalogService(
                id: 'svc-ac',
                categoryId: 'cat-1',
                nameEn: 'AC repair',
                nameAr: 'مكيفات',
              ),
            ],
          ),
        ],
        cities: [City(id: 'city-ruh', nameEn: 'Riyadh', nameAr: 'الرياض')],
      );
      await tester.tap(find.text('Try again').first);
      await _settle(tester);
      expect(find.byKey(const Key('service-svc-ac')), findsOneWidget);
      expect(find.byKey(const Key('city-city-ruh')), findsOneWidget);
      expect(find.byKey(const Key('no-services')), findsNothing);
    },
  );

  testWidgets(
    'services without cities (or cities without services) are each reported on their own',
    (tester) async {
      await _open(
        tester,
        catalog: const Catalog(
          categories: [
            CatalogCategory(
              id: 'c',
              nameEn: 'Home',
              nameAr: 'منزل',
              services: [
                CatalogService(
                  id: 's1',
                  categoryId: 'c',
                  nameEn: 'AC',
                  nameAr: 'مكيف',
                ),
              ],
            ),
          ],
          cities: [],
        ),
      );
      expect(find.byKey(const Key('service-s1')), findsOneWidget);
      expect(find.byKey(const Key('no-services')), findsNothing);
      expect(find.byKey(const Key('no-cities')), findsOneWidget);
    },
  );
}
