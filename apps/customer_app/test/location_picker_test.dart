import 'package:customer_app/app/app_scope.dart';
import 'package:customer_app/app/app_state.dart';
import 'package:customer_app/app/theme/app_theme.dart';
import 'package:customer_app/features/location/models/picked_location.dart';
import 'package:customer_app/features/location/screens/location_picker_screen.dart';
import 'package:customer_app/features/location/services/device_location.dart';
import 'package:customer_app/features/location/services/places_service.dart';
import 'package:customer_app/shared/widgets/tiles.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' show LatLng;

/// Drives the real picker screen. The map (a platform view) and the Google services are test doubles: this proves the screen's behaviour
/// (debouncing, session tokens, permission states, errors, what it returns), not Google's answers.
class FakePlaces implements PlacesService {
  final List<String> calls = [];
  List<PlaceSuggestion> suggestions = const [
    PlaceSuggestion(
      placeId: 'p1',
      primary: 'King Fahd Road',
      secondary: 'Al Olaya, Riyadh',
    ),
  ];
  Object? autocompleteResult; // an Exception to throw
  Object? detailsResult;
  Object? reverseResult = const ResolvedAddress(
    address: 'Anas Ibn Malik Rd, Al Malqa, Riyadh',
    district: 'Al Malqa',
    city: 'Riyadh',
    placeId: 'g1',
  );
  final List<String> tokens = [];
  final List<String> detailTokens = [];
  final List<String> languages = [];
  int reverseCalls = 0;
  int autocompleteCalls = 0;

  @override
  Future<List<PlaceSuggestion>> autocomplete(
    String query, {
    required String sessionToken,
    required String languageCode,
    double? biasLatitude,
    double? biasLongitude,
  }) async {
    autocompleteCalls++;
    calls.add('autocomplete:$query');
    tokens.add(sessionToken);
    languages.add(languageCode);
    final r = autocompleteResult;
    if (r is Exception) throw r;
    return suggestions;
  }

  @override
  Future<ResolvedAddress> details(
    String placeId, {
    required String sessionToken,
    required String languageCode,
  }) async {
    calls.add('details:$placeId');
    detailTokens.add(sessionToken);
    final r = detailsResult;
    if (r is Exception) throw r;
    return (r as ResolvedAddress?) ??
        const ResolvedAddress(
          address: 'King Fahd Rd, Al Olaya, Riyadh',
          latitude: 24.7136,
          longitude: 46.6753,
          placeId: 'p1',
          district: 'Al Olaya',
          city: 'Riyadh',
        );
  }

  @override
  Future<ResolvedAddress?> reverseGeocode(
    double latitude,
    double longitude, {
    required String languageCode,
  }) async {
    reverseCalls++;
    languages.add(languageCode);
    final r = reverseResult;
    if (r is Exception) throw r;
    return r as ResolvedAddress?;
  }
}

class FakeDevice implements DeviceLocation {
  LocationAccess access = LocationAccess.granted;
  DeviceFix? fix = const DeviceFix(24.80, 46.70);
  int requests = 0;
  int statusChecks = 0;
  int reads = 0;
  int appSettings = 0;
  int locationSettings = 0;

  @override
  Future<LocationAccess> status() async {
    statusChecks++;
    return access;
  }

  @override
  Future<LocationAccess> request() async {
    requests++;
    return access;
  }

  @override
  Future<DeviceFix?> current() async {
    reads++;
    return fix;
  }

  @override
  Future<void> openAppSettings() async => appSettings++;
  @override
  Future<void> openLocationSettings() async => locationSettings++;
}

class FakeMap implements PickerMapHandle {
  PickerMapArgs? args;
  final List<LatLng> moves = [];

  Widget build(PickerMapArgs a) {
    args = a;
    a.onReady(this);
    return const ColoredBox(color: Color(0xFFE4ECE9));
  }

  /// The person drags the map: the camera moves, then settles.
  Future<void> drag(WidgetTester tester, LatLng to) async {
    args!.onMoved(to);
    args!.onIdle();
    await tester.pump();
  }

  @override
  Future<void> moveTo(LatLng target) async {
    moves.add(target);
    // a real map animates the camera and then reports it idle
    args!.onMoved(target);
    args!.onIdle();
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

class _Rig {
  _Rig({this.initial});
  final PickedLocation? initial;
  final places = FakePlaces();
  final device = FakeDevice();
  final map = FakeMap();
  PickedLocation? result;
  bool popped = false;
}

Future<_Rig> _open(
  WidgetTester tester, {
  PickedLocation? initial,
  bool arabic = false,
}) async {
  tester.view.physicalSize = const Size(
    390 * 3,
    1700 * 3,
  ); // tall, so every field of the lazily built panel exists
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final rig = _Rig(initial: initial);
  await tester.pumpWidget(
    AppScope(
      state: AppState()..setArabic(arabic),
      child: MaterialApp(
        theme: AppTheme.of(arabic: arabic),
        locale: Locale(arabic ? 'ar' : 'en'),
        supportedLocales: const [Locale('en'), Locale('ar')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  rig.result = await Navigator.of(context).push<PickedLocation>(
                    MaterialPageRoute(
                      builder: (_) => LocationPickerScreen(
                        initial: initial,
                        places: rig.places,
                        device: rig.device,
                        mapBuilder: rig.map.build,
                      ),
                    ),
                  );
                  rig.popped = true;
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return rig;
}

Future<void> _settleTimers(WidgetTester tester, [int ms = 600]) async {
  await tester.pump(Duration(milliseconds: ms));
  await tester.pump();
}

const _olaya = LatLng(24.7136, 46.6753);

void main() {
  setUpAll(_loadFonts);

  testWidgets(
    'opens without asking for location permission or reading the position, and nothing can be confirmed until a point is chosen',
    (tester) async {
      final rig = await _open(tester);
      expect(rig.device.requests, 0);
      expect(rig.device.reads, 0);
      expect(rig.places.reverseCalls, 0); // the default centre is not a choice
      await tester.tap(find.text('Confirm location'));
      await tester.pump();
      expect(rig.popped, isFalse); // disabled
    },
  );

  testWidgets(
    'moving the pin looks up the address once the map settles, shows it, and confirming returns it with the details',
    (tester) async {
      final rig = await _open(tester);
      await rig.map.drag(tester, _olaya);
      expect(find.byKey(const Key('picker-address-loading')), findsOneWidget);
      await _settleTimers(tester);
      expect(rig.places.reverseCalls, 1);
      expect(find.byKey(const Key('picker-address-loading')), findsNothing);
      expect(find.text('Anas Ibn Malik Rd, Al Malqa, Riyadh'), findsOneWidget);

      await tester.ensureVisible(find.byKey(const Key('picker-locLabelHome')));
      await tester.tap(find.byKey(const Key('picker-locLabelHome')));
      await tester.enterText(find.byKey(const Key('picker-building')), '12');
      await tester.enterText(find.byKey(const Key('picker-unit')), '4');
      await tester.enterText(find.byKey(const Key('picker-floor')), '2');
      await tester.enterText(
        find.byKey(const Key('picker-notes')),
        'Ring the bell twice',
      );
      await tester.ensureVisible(find.text('Confirm location'));
      await tester.tap(find.text('Confirm location'));
      await tester.pumpAndSettle();

      final r = rig.result!;
      expect(r.latitude, _olaya.latitude);
      expect(r.longitude, _olaya.longitude);
      expect(r.address, 'Anas Ibn Malik Rd, Al Malqa, Riyadh');
      expect(r.district, 'Al Malqa');
      expect(r.city, 'Riyadh');
      expect(r.building, '12');
      expect(r.unit, '4');
      expect(r.floor, '2');
      expect(r.notes, 'Ring the bell twice');
      expect(r.label, 'Home');
      expect(r.toBookingFields()['building'], '12, Unit 4, Floor 2');
    },
  );

  testWidgets(
    'rapid map movement makes one lookup, for the last position (debounce), and a stale answer is dropped',
    (tester) async {
      final rig = await _open(tester);
      for (final p in [
        const LatLng(24.70, 46.60),
        const LatLng(24.71, 46.61),
        const LatLng(24.72, 46.62),
      ]) {
        await rig.map.drag(tester, p);
        await tester.pump(
          const Duration(milliseconds: 100),
        ); // less than the debounce
      }
      expect(rig.places.reverseCalls, 0);
      await _settleTimers(tester);
      expect(rig.places.reverseCalls, 1);
    },
  );

  testWidgets(
    'a place with no address says so and still lets the customer type one',
    (tester) async {
      final rig = await _open(tester);
      rig.places.reverseResult = null;
      await rig.map.drag(tester, _olaya);
      await _settleTimers(tester);
      expect(find.byKey(const Key('picker-address-none')), findsOneWidget);
      expect(find.text('Confirm location'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('picker-address')),
        'Behind the old market, Diriyah',
      );
      await tester.pump();
      await tester.ensureVisible(find.text('Confirm location'));
      await tester.tap(find.text('Confirm location'));
      await tester.pumpAndSettle();
      expect(rig.result!.address, 'Behind the old market, Diriyah');
    },
  );

  group('search', () {
    testWidgets(
      'waits for 3 characters and a pause, then searches once; picking a result moves the map and fills the address',
      (tester) async {
        final rig = await _open(tester);
        await tester.enterText(find.byKey(const Key('picker-search')), 'ki');
        await _settleTimers(tester);
        expect(rig.places.autocompleteCalls, 0);
        await tester.enterText(find.byKey(const Key('picker-search')), 'kin');
        await tester.enterText(find.byKey(const Key('picker-search')), 'king');
        await tester.enterText(
          find.byKey(const Key('picker-search')),
          'king fahd',
        );
        await _settleTimers(tester);
        expect(rig.places.autocompleteCalls, 1);
        expect(rig.places.calls.single, 'autocomplete:king fahd');
        expect(find.text('King Fahd Road'), findsOneWidget);

        await tester.tap(find.byKey(const Key('suggestion-p1')));
        await tester.pumpAndSettle();
        expect(rig.map.moves.single, const LatLng(24.7136, 46.6753));
        expect(find.text('King Fahd Rd, Al Olaya, Riyadh'), findsOneWidget);
        expect(
          rig.places.reverseCalls,
          0,
        ); // the details already gave the address: no second lookup
        await tester.ensureVisible(find.text('Confirm location'));
        await tester.tap(find.text('Confirm location'));
        await tester.pumpAndSettle();
        expect(rig.result!.district, 'Al Olaya');
        expect(rig.result!.placeId, 'p1');
      },
    );

    testWidgets(
      'uses one session token for the autocomplete calls and the details call, then a fresh one',
      (tester) async {
        final rig = await _open(tester);
        await tester.enterText(
          find.byKey(const Key('picker-search')),
          'king fahd',
        );
        await _settleTimers(tester);
        await tester.enterText(
          find.byKey(const Key('picker-search')),
          'king fahd road',
        );
        await _settleTimers(tester);
        expect(rig.places.tokens.toSet(), hasLength(1));
        await tester.tap(find.byKey(const Key('suggestion-p1')));
        await tester.pumpAndSettle();
        expect(rig.places.detailTokens.single, rig.places.tokens.first);
        // a new search after choosing starts a new session
        await tester.enterText(
          find.byKey(const Key('picker-search')),
          'olaya street',
        );
        await _settleTimers(tester);
        expect(rig.places.tokens.last, isNot(rig.places.tokens.first));
      },
    );

    testWidgets(
      'quota and network failures are explained, with a retry for search',
      (tester) async {
        final rig = await _open(tester);
        rig.places.autocompleteResult = const PlacesException(
          PlacesFailure.quota,
        );
        await tester.enterText(
          find.byKey(const Key('picker-search')),
          'king fahd',
        );
        await _settleTimers(tester);
        expect(
          find.text(
            'Too many requests right now. Please wait a moment and try again.',
          ),
          findsOneWidget,
        );
        rig.places.autocompleteResult = null;
        await tester.tap(find.text('Try again'));
        await _settleTimers(tester);
        expect(find.text('King Fahd Road'), findsOneWidget);
      },
    );

    testWidgets('no matches says so', (tester) async {
      final rig = await _open(tester);
      rig.places.suggestions = const [];
      await tester.enterText(find.byKey(const Key('picker-search')), 'zzzzzz');
      await _settleTimers(tester);
      expect(find.text('No places found. Try another word.'), findsOneWidget);
    });

    testWidgets('searches in the customer\'s language', (tester) async {
      final rig = await _open(tester, arabic: true);
      await tester.enterText(
        find.byKey(const Key('picker-search')),
        'طريق الملك',
      );
      await _settleTimers(tester);
      expect(rig.places.languages, everyElement('ar'));
      expect(find.text('موقع الخدمة'), findsOneWidget);
      expect(find.text('تأكيد الموقع'), findsOneWidget);
    });
  });

  group('current location', () {
    testWidgets(
      'granted: moves the pin to the position and looks up its address',
      (tester) async {
        final rig = await _open(tester);
        await tester.tap(find.byKey(const Key('picker-locate')));
        await tester.pumpAndSettle(const Duration(milliseconds: 700));
        expect(rig.device.requests, 1);
        expect(rig.device.reads, 1);
        expect(rig.map.moves.single, const LatLng(24.80, 46.70));
        await _settleTimers(tester);
        expect(rig.places.reverseCalls, 1);
        expect(find.byKey(const Key('picker-access-notice')), findsNothing);
      },
    );

    for (final c in {
      LocationAccess.denied:
          'Location permission was not granted. Search for an address or move the pin instead.',
      LocationAccess.deniedForever:
          'Location is blocked for this app. You can allow it in Settings, or search or move the pin.',
      LocationAccess.serviceOff:
          'Location services are turned off on your phone. Turn them on, or search or move the pin.',
    }.entries) {
      testWidgets(
        '${c.key.name}: explains, never reads the position, and the app still works by search or moving the pin',
        (tester) async {
          final rig = await _open(tester);
          rig.device.access = c.key;
          await tester.tap(find.byKey(const Key('picker-locate')));
          await tester.pumpAndSettle();
          expect(find.text(c.value), findsOneWidget);
          expect(rig.device.reads, 0);
          // manual selection still works
          await rig.map.drag(tester, _olaya);
          await _settleTimers(tester);
          await tester.ensureVisible(find.text('Confirm location'));
          await tester.tap(find.text('Confirm location'));
          await tester.pumpAndSettle();
          expect(rig.result, isNotNull);
        },
      );
    }

    testWidgets(
      'blocked for good offers the app settings; services off offers the location settings',
      (tester) async {
        final rig = await _open(tester);
        rig.device.access = LocationAccess.deniedForever;
        await tester.tap(find.byKey(const Key('picker-locate')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Open settings'));
        expect(rig.device.appSettings, 1);
        rig.device.access = LocationAccess.serviceOff;
        await tester.tap(find.byKey(const Key('picker-locate')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Open settings'));
        expect(rig.device.locationSettings, 1);
      },
    );

    testWidgets(
      'permission granted but no fix: says it could not read the location',
      (tester) async {
        final rig = await _open(tester);
        rig.device.fix = null;
        await tester.tap(find.byKey(const Key('picker-locate')));
        await tester.pumpAndSettle();
        expect(
          find.text(
            'We could not read your location. Search for an address or move the pin.',
          ),
          findsOneWidget,
        );
        expect(rig.map.moves, isEmpty);
      },
    );
  });

  group('address lookup errors', () {
    testWidgets(
      'a network failure is explained, can be retried, and the retry succeeds',
      (tester) async {
        final rig = await _open(tester);
        rig.places.reverseResult = const PlacesException(PlacesFailure.network);
        await rig.map.drag(tester, _olaya);
        await _settleTimers(tester);
        expect(find.byKey(const Key('picker-address-error')), findsOneWidget);
        expect(
          find.text('No connection. Check your internet and try again.'),
          findsOneWidget,
        );
        rig.places.reverseResult = const ResolvedAddress(
          address: 'Retry Street, Riyadh',
        );
        await tester.tap(find.byKey(const Key('picker-address-retry')));
        await _settleTimers(tester);
        expect(find.text('Retry Street, Riyadh'), findsOneWidget);
        expect(find.byKey(const Key('picker-address-error')), findsNothing);
      },
    );

    testWidgets('quota and denied lookups give their own messages', (
      tester,
    ) async {
      final rig = await _open(tester);
      rig.places.reverseResult = const PlacesException(PlacesFailure.quota);
      await rig.map.drag(tester, _olaya);
      await _settleTimers(tester);
      expect(
        find.text(
          'Too many requests right now. Please wait a moment and try again.',
        ),
        findsOneWidget,
      );
      rig.places.reverseResult = const PlacesException(PlacesFailure.denied);
      await rig.map.drag(tester, const LatLng(24.5, 46.5));
      await _settleTimers(tester);
      expect(
        find.text(
          'The map service refused this request. Please contact support.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'without a key the picker says maps are not set up, but the customer can still type an address for the chosen point',
      (tester) async {
        final rig = await _open(tester);
        rig.places.reverseResult = const PlacesException(
          PlacesFailure.notConfigured,
        );
        await rig.map.drag(tester, _olaya);
        await _settleTimers(tester);
        expect(
          find.textContaining('Maps are not set up in this build'),
          findsWidgets,
        );
        expect(find.byKey(const Key('picker-address-retry')), findsNothing);
        await tester.enterText(
          find.byKey(const Key('picker-address')),
          'Villa 7, Al Narjis',
        );
        await tester.pump();
        await tester.ensureVisible(find.text('Confirm location'));
        await tester.tap(find.text('Confirm location'));
        await tester.pumpAndSettle();
        expect(rig.result!.address, 'Villa 7, Al Narjis');
      },
    );

    testWidgets(
      'repeating the same point uses the cache instead of asking again',
      (tester) async {
        final rig = await _open(tester);
        await rig.map.drag(tester, _olaya);
        await _settleTimers(tester);
        await rig.map.drag(tester, const LatLng(24.5, 46.5));
        await _settleTimers(tester);
        await rig.map.drag(tester, _olaya);
        await _settleTimers(tester);
        expect(rig.places.reverseCalls, 2);
      },
    );
  });

  testWidgets(
    'editing a saved choice starts from it: its address is kept and no new lookup is made until the pin moves',
    (tester) async {
      final rig = await _open(
        tester,
        initial: const PickedLocation(
          latitude: 24.7,
          longitude: 46.6,
          address: 'Saved Street 5, Riyadh',
          district: 'Al Olaya',
          building: '9',
          label: 'Office',
        ),
      );
      expect(find.text('Saved Street 5, Riyadh'), findsOneWidget);
      expect(rig.places.reverseCalls, 0);
      await tester.ensureVisible(find.text('Confirm location'));
      await tester.tap(find.text('Confirm location'));
      await tester.pumpAndSettle();
      expect(rig.result!.address, 'Saved Street 5, Riyadh');
      expect(rig.result!.latitude, 24.7);
      expect(rig.result!.building, '9');
      expect(rig.result!.label, 'Office');
    },
  );

  testWidgets('backing out returns nothing', (tester) async {
    final rig = await _open(tester);
    await tester.tap(find.byType(SquareIconButton));
    await tester.pumpAndSettle();
    expect(rig.popped, isTrue);
    expect(rig.result, isNull);
  });
}
