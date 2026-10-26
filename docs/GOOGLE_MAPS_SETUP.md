# Google Maps: setup, security and roadmap

Covers the **customer service-location picker** (customer app). Nothing here creates or changes a credential: you supply the key.

## 1. What was built

`apps/customer_app/lib/features/location/`

| Part | File |
|---|---|
| Picker screen (map + fixed pin, search, current location, address and details, confirm) | `screens/location_picker_screen.dart` |
| Places API (New) autocomplete and details, Geocoding API reverse lookup | `services/places_service.dart` |
| Location permission and one position read (geolocator) | `services/device_location.dart` |
| The confirmed result, mapped onto the backend's booking location fields | `models/picked_location.dart` |

The booking flow's "where" step opens the picker (the map preview chip, and the "Choose on the map" button) and shows the confirmed place as a selectable card. The booking itself is still the prototype flow; when it is wired to `POST /bookings`, send `pickedLocation.toBookingFields()`: `addressLine`, `district`, `building` ("12, Unit 4, Floor 2"), `locationNotes`, `latitude`, `longitude`. The backend already validates these (`IsLatitude`/`IsLongitude`, length limits), so **no backend change was needed**. The label ("Home", "Office") is kept on the phone only.

Behaviour you can rely on:

* The app never needs location permission. Asking happens only when the customer taps "Use my current location". Denied, blocked for good, services off and "could not read position" each show a message and leave search and moving the pin working.
* The pin is fixed at the centre; the customer moves the map under it. The default centre (Riyadh) is **not** a choice: nothing can be confirmed until the customer moves the map, searches, or uses their location.
* Address lookup runs once the map has settled (450 ms), is cached per ~10 m, and a newer position cancels an older answer.
* Search starts at 3 characters, is debounced (350 ms), restricted to Saudi Arabia, biased to the map centre, and uses **one session token** per search (autocomplete calls and the final details call), so a search is billed as one session.
* The address is editable (customers correct Google's guess). English and Arabic: the requests use the app language.
* The picker does **not** decide whether an address is in a covered area. The backend has no geographic service-area rule (cities are a list). The picker says so, and the booking's city is chosen separately. Matching the reported locality to a catalog city would be a guess and was not done.

## 2. Configure the key (you do this; the repository never contains it)

You need one key with the five APIs enabled (Maps SDK for Android, Maps SDK for iOS, Places API (New), Geocoding API, Routes API; the picker uses the first four).

**Android and Dart (one place):** create `apps/customer_app/maps.local.json` (git-ignored; copy `maps.local.json.example`):

```json
{ "GOOGLE_MAPS_API_KEY": "your-key" }
```

Run with `--dart-define-from-file=maps.local.json`. Flutter hands the dart-defines to Gradle, which puts the key into the manifest placeholder `${MAPS_API_KEY}` (`android/app/build.gradle.kts`). Alternatives for Android only: `MAPS_API_KEY=` in `android/local.properties`, a Gradle property, or the `MAPS_API_KEY` environment variable.

**iOS:** copy `ios/Flutter/Secrets.xcconfig.example` to `ios/Flutter/Secrets.xcconfig` (git-ignored) and set `MAPS_API_KEY=`. `Info.plist` reads it as `GMSApiKey`, and `AppDelegate.swift` passes it to `GMSServices`. Also pass `--dart-define-from-file=maps.local.json` for the search and address lookup.

Without a key the app still runs: the map shows blank tiles, search and address lookup are off, and the picker says so; the customer can still type an address for the point they chose.

Commands:

```bash
cd apps/customer_app
flutter pub get
flutter run --dart-define-from-file=maps.local.json --dart-define=API_BASE_URL=http://10.0.2.2:3001/api/v1
# release (HTTPS API, your signing key; see docs/RELEASE_BUILDS.md)
flutter build appbundle --release --dart-define-from-file=maps.local.json --dart-define=API_BASE_URL=https://api.example.com/api/v1
```

## 3. Key security (read before release)

* **A key inside a mobile app can be extracted** from the installed package. Anyone who extracts it can use your quota and bill. Restriction is the only defence.
* **During development** minimal restrictions are convenient and acceptable on a project with a **billing budget and alerts**. Do not publish an unrestricted key in a release build.
* **Before release**, in Google Cloud Console:
  1. Prefer **separate keys** for the SDKs and the REST calls so each can be restricted differently. The app currently uses ONE key for both (`GOOGLE_MAPS_API_KEY`); splitting needs a second define (a small change in `build.gradle.kts`, `Secrets.xcconfig` and `maps_config.dart`). Until then use the key with API restrictions covering the four APIs and, before release, application restrictions as far as the REST caveat in step 4 allows.
  2. Android SDK key: restrict by **package name** `com.saudihomeservices.customer_app` and your release **SHA-1** (and Play app-signing SHA-1 if you use Play App Signing). iOS SDK key: restrict by **bundle ID** `com.saudihomeservices.customerApp`.
  3. API restrictions: the SDK key allows only *Maps SDK for Android/iOS*; the REST key allows only *Places API (New)* and *Geocoding API*.
  4. The REST calls are made from the app over HTTPS. An application-restricted key (package/SHA) only works for REST if the request carries the `X-Android-Package` / `X-Android-Cert` (or `X-Ios-Bundle-Identifier`) headers, which this client does not send yet. Until you add them (a small change in `places_service.dart`) either leave the REST key API-restricted only, or move Places/Geocoding behind the backend with a **server-only key** (never shipped to Flutter), which is the stronger design.
  5. Set per-API **quotas** and a **budget alert**; review usage weekly at first.
* The key is never logged or placed in an exception; the Geocoding API requires it in the query string, so do not enable request logging on proxies you add.

## 4. Platform notes

* **Android:** `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` added (requested at runtime, only on the button). Minimum SDK unchanged (`flutter.minSdkVersion`); the Maps plugin supports it.
* **iOS:** `NSLocationWhenInUseUsageDescription` added. **Deployment target:** the Xcode project says 13.0, but the Firebase plugins already in the app require **iOS 15.0** and Google Maps requires 14.0. The project cannot build for iOS at 13.0 even without Maps. It was **not** changed here; raise `IPHONEOS_DEPLOYMENT_TARGET` to 15.0 (Xcode: Runner target, or set `platform :ios, '15.0'` in the Podfile Flutter generates) when you build on a Mac. iOS was not built here (no Apple toolchain on this machine).

## 5. Proposed (not applied): saved addresses

Reusing addresses needs a table; the backend has none (bookings keep a location **snapshot**, which stays). **No migration was created.** Proposal for your approval:

```
customer_addresses
  id uuid pk, user_id uuid fk users on delete cascade (indexed)
  label varchar(60) null, address_line varchar(255), district varchar(120) null, city_id uuid fk cities null
  building varchar(120) null, notes varchar(500) null
  latitude double precision, longitude double precision      -- CHECK ranges
  place_id varchar(255) null, is_default boolean, created_at, updated_at, deleted_at null
  unique (user_id) where is_default and deleted_at is null   -- one default
```

Routes, following the existing `customers/me` conventions (role CUSTOMER, owner taken from the access token, never from the body): `GET /customers/me/addresses`, `POST /customers/me/addresses`, `PATCH /customers/me/addresses/:id`, `DELETE /customers/me/addresses/:id` (soft delete), with a per-user cap (for example 20) and the same validation as the booking location fields. An address id from another user answers 404.

## 6. Roadmap (separate phases; not implemented)

1. **Saved addresses** (section 5): list/pick/edit/delete in the picker and booking step.
2. **Worker app: booking location.** Show the exact point and address to the assigned worker only after payment/confirmation (the backend already withholds the street address until then); open turn-by-turn navigation in Google Maps / Apple Maps via a `geo:` / `https://www.google.com/maps/dir/?api=1&destination=` link (no Routes API needed for that).
3. **Distance and ETA** (Routes API, server-side with a server-only key): compute on the backend and cache per booking; show in quotes and tracking. Budget carefully: Routes billing is per element.
4. **Matching:** extend worker matching with distance (existing priorities stay: approved, available, service and city eligible), using a straight-line pre-filter before any Routes call.
5. **Live worker tracking** (existing realtime module and `LOCATION_*` settings): authorize by booking participation; share only during the permitted window; throttle updates; mark stale positions; drop precision for the customer; stop on completion/cancellation or window end; never persist a trail beyond need; show the marker only to the booking's customer.
6. **Production hardening:** key restrictions (section 3), quotas and budget alerts, error monitoring for Places/Geocoding failures (the picker already distinguishes quota, denied, network), privacy review of location data (retention, access logging), and consent text for location use in both stores.
