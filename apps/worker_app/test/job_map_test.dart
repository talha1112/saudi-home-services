import 'support/worker_harness.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;
import 'package:hs_client/hs_client.dart'
    show ApiException, BookingLocation, WorkerJob;
import 'package:hs_client/testing.dart';
import 'package:worker_app/app/app_state.dart';
import 'package:worker_app/app/auth_scope.dart';
import 'package:worker_app/app/app_scope.dart';
import 'package:worker_app/app/jobs_scope.dart';
import 'package:worker_app/app/theme/app_theme.dart';
import 'package:worker_app/features/jobs/screens/active_job_screen.dart';
import 'package:worker_app/features/jobs/services/directions.dart';
import 'package:worker_app/features/jobs/widgets/job_location_map.dart';
import 'package:worker_app/features/jobs/widgets/job_map.dart';
import 'package:worker_app/shared/models/worker_data.dart';

class _FakeDirections implements DirectionsLauncher {
  _FakeDirections({this.succeeds = true});
  final bool succeeds;
  final List<(double, double)> opened = [];

  @override
  Future<bool> open(double latitude, double longitude) async {
    opened.add((latitude, longitude));
    return succeeds;
  }
}

Future<void> _loadFonts() async {
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

Widget _host(Widget child, {bool arabic = false, AppState? state}) {
  final kit = TestHsClient();
  return AuthScope(
    controller: kit.client.auth,
    child: AppScope(
      state: (state ?? AppState())..setArabic(arabic),
      child: MaterialApp(
        theme: AppTheme.of(arabic: arabic),
        locale: Locale(arabic ? 'ar' : 'en'),
        supportedLocales: const [Locale('en'), Locale('ar')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: child,
      ),
    ),
  );
}

Widget _fakeMap(LatLng target) => Container(
  key: Key('fake-map-${target.latitude},${target.longitude}'),
  color: const Color(0xFFE4ECE9),
);

void main() {
  setUpAll(_loadFonts);

  group('directions link', () {
    test(
      'is the Google Maps directions URL for the destination, with no key in it',
      () {
        final u = directionsUri(24.7136, 46.6753);
        expect(u.scheme, 'https');
        expect(u.host, 'www.google.com');
        expect(u.path, '/maps/dir/');
        expect(u.queryParameters, {
          'api': '1',
          'destination': '24.7136,46.6753',
          'travelmode': 'driving',
        });
        expect(u.toString(), isNot(contains('key=')));
      },
    );

    test('coordinate validation', () {
      expect(validCoordinates(24.7, 46.6), isTrue);
      expect(validCoordinates(null, 46.6), isFalse);
      expect(validCoordinates(24.7, null), isFalse);
      expect(validCoordinates(91, 0), isFalse);
      expect(validCoordinates(0, -181), isFalse);
      expect(validCoordinates(double.nan, 0), isFalse);
      expect(validCoordinates(double.infinity, 0), isFalse);
    });

    test(
      'the real launcher refuses invalid coordinates without trying',
      () async {
        expect(await const UrlDirectionsLauncher().open(200, 0), isFalse);
        expect(
          await const UrlDirectionsLauncher().open(double.nan, 0),
          isFalse,
        );
      },
    );
  });

  group('JobLocationMap', () {
    testWidgets(
      'shows the real map at the job\'s exact point when a key is set',
      (tester) async {
        await tester.pumpWidget(
          _host(
            const Scaffold(
              body: JobLocationMap(
                latitude: 24.7136,
                longitude: 46.6753,
                mapsEnabled: true,
                mapBuilder: _fakeMap,
              ),
            ),
          ),
        );
        expect(
          find.byKey(const Key('fake-map-24.7136,46.6753')),
          findsOneWidget,
        );
        expect(find.byType(JobMap), findsNothing);
      },
    );

    testWidgets('falls back to the illustrated map without a key', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const Scaffold(
            body: JobLocationMap(
              latitude: 24.7136,
              longitude: 46.6753,
              mapsEnabled: false,
              mapBuilder: _fakeMap,
            ),
          ),
        ),
      );
      expect(find.byType(JobMap), findsOneWidget);
    });

    testWidgets('falls back when the job has no usable coordinates', (
      tester,
    ) async {
      for (final c in [
        (null, null),
        (24.7, null),
        (95.0, 46.6),
        (24.7, 200.0),
      ]) {
        await tester.pumpWidget(
          _host(
            Scaffold(
              body: JobLocationMap(
                latitude: c.$1,
                longitude: c.$2,
                mapsEnabled: true,
                mapBuilder: _fakeMap,
              ),
            ),
          ),
        );
        expect(find.byType(JobMap), findsOneWidget, reason: '$c');
        await tester.pumpWidget(const SizedBox());
      }
    });
  });

  group('active job screen (a real assigned booking)', () {
    Future<({TestHsClient kit, JobsServices services})> open(
      WidgetTester tester,
      WorkerJob job, {
      DirectionsLauncher? directions,
      bool? mapsEnabled = true,
      bool arabic = false,
      bool Function(String)? ignore,
    }) async {
      phoneSize(tester, height: 900);
      final kit = workerKit();
      await signInWorker(kit);
      kit.api.workerJobList.add(job);
      final services = makeJobsServices(kit);
      addTearDown(() {
        services.jobs.dispose();
        services.quotes.dispose();
        kit.client.auth.dispose();
      });
      await tester.pumpWidget(
        workerHarness(
          kit: kit,
          services: services,
          state: AppState()..setArabic(arabic),
          arabic: arabic,
          home: ActiveJobScreen(
            jobId: job.id,
            directions: directions ?? _FakeDirections(),
            mapsEnabled: mapsEnabled,
            mapBuilder: _fakeMap,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      return (kit: kit, services: services);
    }

    testWidgets(
      'a paid job shows the real map at the exact point the backend released',
      (tester) async {
        await open(tester, job());
        expect(
          find.byKey(const Key('fake-map-24.7136,46.6753')),
          findsOneWidget,
        );
        expect(find.byType(JobMap), findsNothing);
      },
    );

    testWidgets('the navigate button opens directions to that point', (
      tester,
    ) async {
      final launcher = _FakeDirections();
      await open(tester, job(), directions: launcher, mapsEnabled: false);
      await tester.tap(find.byKey(const Key('navigate-button')));
      await tester.pump();
      expect(launcher.opened, [(24.7136, 46.6753)]);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets(
      'without a Maps key the illustration is shown, and directions still work',
      (tester) async {
        final launcher = _FakeDirections();
        await open(tester, job(), directions: launcher, mapsEnabled: false);
        expect(find.byType(JobMap), findsOneWidget);
        await tester.tap(find.byKey(const Key('navigate-button')));
        await tester.pump();
        expect(launcher.opened, [(24.7136, 46.6753)]);
      },
    );

    testWidgets(
      'says so when no maps app or browser could be opened (English and Arabic)',
      (tester) async {
        await open(tester, job(), directions: _FakeDirections(succeeds: false));
        await tester.tap(find.byKey(const Key('navigate-button')));
        await tester.pump();
        expect(
          find.text(
            'Could not open Maps. Check that a maps app or browser is available.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('the failure message is shown in Arabic too', (tester) async {
      await open(
        tester,
        job(),
        directions: _FakeDirections(succeeds: false),
        arabic: true,
      );
      await tester.tap(find.byKey(const Key('navigate-button')));
      await tester.pump();
      expect(find.textContaining('تعذّر فتح الخرائط'), findsOneWidget);
    });

    testWidgets(
      'a paid job whose point was not given falls back to the illustration and navigation says why',
      (tester) async {
        final launcher = _FakeDirections();
        const noPoint = BookingLocation(
          cityId: 'c',
          cityNameEn: 'Riyadh',
          district: 'Al Olaya',
          addressLine: 'King Fahd Rd',
        );
        await open(tester, job(location: noPoint), directions: launcher);
        expect(find.byType(JobMap), findsOneWidget);
        expect(find.byKey(const Key('job-no-point')), findsOneWidget);
        await tester.tap(find.byKey(const Key('navigate-button')));
        await tester.pump();
        expect(launcher.opened, isEmpty);
        expect(
          find.text('The exact location is not available for this job yet.'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'before payment: area only, an illustration instead of a pin, no customer contact, nothing to start',
      (tester) async {
        final launcher = _FakeDirections();
        await open(
          tester,
          job(status: 'PAYMENT_PENDING', released: false),
          directions: launcher,
        );

        expect(
          find.byType(JobMap),
          findsOneWidget,
          reason: 'the illustration, not a pin at an invented place',
        );
        expect(find.byKey(const Key('waiting-payment')), findsOneWidget);
        expect(find.byKey(const Key('job-address')), findsOneWidget);
        expect(find.text('Al Olaya · Riyadh'), findsOneWidget);
        expect(find.textContaining('King Fahd'), findsNothing);
        expect(find.byKey(const Key('job-phone')), findsNothing);
        expect(find.byKey(const Key('call-button')), findsNothing);
        expect(
          find.byKey(const Key('job-action')),
          findsNothing,
          reason: 'the backend only starts a job that is paid',
        );

        await tester.tap(find.byKey(const Key('navigate-button')));
        await tester.pump();
        expect(launcher.opened, isEmpty);
        expect(
          find.text('The exact location is not available for this job yet.'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'once paid the same job shows the address, the customer, and a call button',
      (tester) async {
        final launched = <Uri>[];
        phoneSize(tester, height: 900);
        final kit = workerKit();
        await signInWorker(kit);
        kit.api.workerJobList.add(job());
        final services = makeJobsServices(kit);
        addTearDown(() {
          services.jobs.dispose();
          services.quotes.dispose();
          kit.client.auth.dispose();
        });
        await tester.pumpWidget(
          workerHarness(
            kit: kit,
            services: services,
            state: AppState(),
            home: ActiveJobScreen(
              jobId: 'job-1',
              mapsEnabled: false,
              openLink: (uri) async {
                launched.add(uri);
                return true;
              },
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));

        expect(find.text('Sara'), findsOneWidget);
        expect(find.text('King Fahd Rd, Al Olaya · 12'), findsOneWidget);
        expect(find.byKey(const Key('job-notes')), findsOneWidget);
        expect(find.byKey(const Key('job-phone')), findsOneWidget);
        await tester.tap(find.byKey(const Key('call-button')));
        await tester.pump();
        expect(launched.single.toString(), 'tel:+966500000000');
      },
    );

    testWidgets(
      'a job that is not this worker\'s (404) is "not available", with no map or location',
      (tester) async {
        phoneSize(tester, height: 900);
        final kit = workerKit();
        await signInWorker(kit);
        final services = makeJobsServices(kit);
        addTearDown(() {
          services.jobs.dispose();
          services.quotes.dispose();
          kit.client.auth.dispose();
        });
        await tester.pumpWidget(
          workerHarness(
            kit: kit,
            services: services,
            state: AppState(),
            home: ActiveJobScreen(
              jobId: 'someone-elses',
              mapsEnabled: true,
              mapBuilder: _fakeMap,
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
        expect(find.byKey(const Key('job-gone')), findsOneWidget);
        expect(find.byKey(const Key('navigate-button')), findsNothing);
        expect(find.byType(JobMap), findsNothing);
      },
    );

    testWidgets('a job that cannot be loaded offers a retry, and recovers', (
      tester,
    ) async {
      phoneSize(tester, height: 900);
      final kit = workerKit();
      await signInWorker(kit);
      kit.api.workerJobList.add(job());
      kit.api.workerJobResult = const ApiException(status: 0, code: 'NETWORK');
      final services = makeJobsServices(kit);
      addTearDown(() {
        services.jobs.dispose();
        services.quotes.dispose();
        kit.client.auth.dispose();
      });
      await tester.pumpWidget(
        workerHarness(
          kit: kit,
          services: services,
          state: AppState(),
          home: ActiveJobScreen(
            jobId: 'job-1',
            mapsEnabled: true,
            mapBuilder: _fakeMap,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byKey(const Key('job-failed')), findsOneWidget);

      kit.api.workerJobResult = null;
      await tester.tap(find.byKey(const Key('job-retry')));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byKey(const Key('fake-map-24.7136,46.6753')), findsOneWidget);
    });

    test(
      'the prototype fixtures are not used by the real screen and carry no real place',
      () {
        for (final r in kRequests) {
          expect(r.toString(), isNot(contains('24.7136')));
        }
      },
    );
  });
}
