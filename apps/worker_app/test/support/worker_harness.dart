import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_scope.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/app/auth_scope.dart';
import 'package:worker_app/app/jobs_scope.dart';
import 'package:worker_app/app/onboarding_scope.dart';
import 'package:worker_app/app/theme/app_theme.dart';
import 'package:worker_app/features/jobs/logic/position_sharer.dart';
import 'package:worker_app/features/jobs/logic/worker_jobs_controller.dart';
import 'package:worker_app/features/quotes/logic/quote_submitter.dart';

/// An APPROVED worker's test client (Firebase and the backend are fakes).
TestHsClient workerKit() => TestHsClient(
  kind: AppKind.worker,
  user: fakeUser(role: 'WORKER', workerStatus: 'APPROVED'),
);

/// Signs the worker in through the real controller.
Future<void> signInWorker(TestHsClient kit) async {
  await kit.client.auth.sendCode('+966551234567');
  await kit.client.auth.submitCode('123456');
}

/// A phone whose location the test controls.
class FakePositionSource implements PositionSource {
  PositionAccess access = PositionAccess.granted;
  PositionReading? reading;
  int requests = 0;
  int settingsOpened = 0;

  @override
  Future<PositionAccess> status() async => access;

  @override
  Future<PositionAccess> request() async {
    requests++;
    return access;
  }

  @override
  Future<PositionReading?> current() async => reading;

  @override
  Future<void> openSettings() async {
    settingsOpened++;
  }
}

/// The controllers the way `App` builds them, on the shared fake backend. The sharer never runs by itself (a one-hour timer); tests call
/// `services.sharer.tick()`.
JobsServices makeJobsServices(TestHsClient kit, {PositionSource? source}) {
  final jobs = WorkerJobsController(api: kit.api, auth: kit.client.auth);
  return JobsServices(
    jobs: jobs,
    quotes: QuoteSubmitter(api: kit.api, auth: kit.client.auth, jobs: jobs),
    sharer: PositionSharer(
      api: kit.api,
      auth: kit.client.auth,
      jobs: jobs,
      source: source ?? FakePositionSource(),
      interval: const Duration(hours: 1),
    ),
    notifications: NotificationsController(api: kit.api, auth: kit.client.auth),
    reviews: ReviewsController(api: kit.api, auth: kit.client.auth),
    openFromNotification: (_) async {},
  );
}

/// A material app with every scope the worker screens need. With [rootRouteName] the root route carries that name (the app's tab shell is
/// '/home'), which lets "back to the shell" navigation work.
Widget workerHarness({
  required TestHsClient kit,
  required JobsServices services,
  required AppState state,
  required Widget home,
  bool arabic = false,
  String? rootRouteName,
  WorkerOnboardingController? onboarding,
}) {
  return AuthScope(
    controller: kit.client.auth,
    child: OnboardingScope(
      controller: onboarding ?? kit.client.onboarding,
      child: JobsScope(
        services: services,
        child: AppScope(
          state: state,
          child: MaterialApp(
            initialRoute: rootRouteName,
            onGenerateRoute: rootRouteName == null
                ? null
                : (settings) => MaterialPageRoute<void>(
                    settings: settings,
                    builder: (_) => home,
                  ),
            theme: AppTheme.of(arabic: arabic),
            locale: Locale(arabic ? 'ar' : 'en'),
            supportedLocales: const [Locale('en'), Locale('ar')],
            localizationsDelegates: const [
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: rootRouteName == null ? home : null,
          ),
        ),
      ),
    ),
  );
}

Future<void> loadWorkerFonts() async {
  const families = {
    'Archivo': ['400', '500', '600', '700', '800'],
    'Tajawal': ['400', '500', '700', '800'],
  };
  for (final entry in families.entries) {
    final loader = FontLoader(entry.key);
    for (final w in entry.value) {
      loader.addFont(rootBundle.load('assets/fonts/${entry.key}-$w.ttf'));
    }
    await loader.load();
  }
}

void phoneSize(WidgetTester tester, {double height = 1000}) {
  tester.view.physicalSize = Size(390 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

// ---- backend-shaped test data

const cityRuh = BookingLocation(
  cityId: 'city-ruh',
  cityNameEn: 'Riyadh',
  cityNameAr: 'الرياض',
  district: 'Al Olaya',
);

/// A booking that is paid: the backend released the exact point to the worker.
const paidPlace = BookingLocation(
  cityId: 'city-ruh',
  cityNameEn: 'Riyadh',
  cityNameAr: 'الرياض',
  district: 'Al Olaya',
  addressLine: 'King Fahd Rd, Al Olaya',
  building: '12',
  locationNotes: 'Ring twice',
  latitude: 24.7136,
  longitude: 46.6753,
);

WorkerMoney money({int price = 25000}) => WorkerMoney(
  currency: 'SAR',
  serviceHalalas: price,
  vatHalalas: (price * 0.15).round(),
  totalHalalas: price + (price * 0.15).round(),
  vatRateBps: 1500,
  commissionHalalas: (price * 0.15).round(),
  payoutHalalas: price - (price * 0.15).round(),
  commissionRateBps: 1500,
);

WorkerRequest request({
  String id = 'req-1',
  String reference = 'HS-1',
  bool urgent = false,
  WorkerQuote? quote,
  String? description,
  int photos = 0,
}) => WorkerRequest(
  id: id,
  reference: reference,
  status: 'OPEN',
  service: const JobService(
    id: 'svc-ac',
    nameEn: 'AC repair',
    nameAr: 'إصلاح المكيفات',
  ),
  location: cityRuh,
  isUrgent: urgent,
  preferredStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
  preferredEndAt: DateTime.now().toUtc().add(const Duration(days: 1, hours: 2)),
  expiresAt: DateTime.now().toUtc().add(const Duration(hours: 40)),
  myQuote: quote,
  createdAt: DateTime.now().toUtc(),
  problemDescription:
      description ?? 'Two split units, weak cooling and water dripping',
  photoCount: photos,
);

WorkerJob job({
  String id = 'job-1',
  String reference = 'HS-2',
  String status = 'CONFIRMED',
  BookingLocation? location,
  bool released = true,
  int price = 25000,
  String? paymentMethod,
  DateTime? cashCollectedAt,
}) => WorkerJob(
  id: id,
  reference: reference,
  status: status,
  service: const JobService(
    id: 'svc-ac',
    nameEn: 'AC repair',
    nameAr: 'إصلاح المكيفات',
  ),
  location: location ?? (released ? paidPlace : cityRuh),
  isUrgent: false,
  preferredStartAt: DateTime.now().toUtc().add(const Duration(days: 1)),
  preferredEndAt: DateTime.now().toUtc().add(const Duration(days: 1, hours: 2)),
  expiresAt: DateTime.now().toUtc().add(const Duration(hours: 40)),
  createdAt: DateTime.now().toUtc(),
  problemDescription: 'Two split units, weak cooling and water dripping',
  money: money(price: price),
  customerName: released ? 'Sara' : null,
  customerPhone: released ? '+966500000000' : null,
  paymentMethod: paymentMethod,
  cashCollectedAt: cashCollectedAt,
);
