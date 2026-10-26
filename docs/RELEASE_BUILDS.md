# Release builds (customer app and worker app)

How a release build gets its backend address and its signing key. Nothing here creates or stores a key; **never commit a keystore,
`key.properties`, passwords or service files** (`.gitignore` already excludes `*.jks`, `*.keystore` and `key.properties`).

## 1. The backend address

Both apps read the API root from `--dart-define=API_BASE_URL=...` (`lib/core/config/api_config.dart`, resolved by `resolveApiBaseUrl` in
`packages/hs_client`).

| Build | No `API_BASE_URL` | `http://...` | `https://...` |
|---|---|---|---|
| debug | `http://10.0.2.2:3001/api/v1` (Android emulator -> development computer) | accepted | accepted |
| release / profile | **the app refuses to start** (`ApiConfigError`) | **refused** | accepted |

Release and profile builds also refuse `localhost`, `10.0.2.2`, `127.*`, `0.0.0.0`, `::1`, addresses with credentials, a query or a fragment.
There is no fallback, so a release build can never quietly talk to the emulator host. Plain HTTP is also blocked by the platform:
`usesCleartextTraffic` appears only in `android/app/src/debug/AndroidManifest.xml`, and neither iOS project has an App Transport Security
exception.

Document uploads follow the same rule: the signed upload address the backend returns must be `https` (plain `http` is accepted only in
debug builds, for local development storage).

## 2. Android signing

Release builds are signed **only** with your own keystore. `android/app/build.gradle.kts` no longer falls back to the debug key: without a
configured key, any release task (`assembleRelease`, `bundleRelease`, `packageRelease`...) **fails** with "Release signing is not configured".

Create `android/key.properties` in each app (git-ignored; keep the keystore outside the repository):

```properties
storeFile=C:/secure/keystores/customer-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

`storeFile` may be absolute, or relative to the `android/` folder. Use a different keystore (or at least alias) per app. The package IDs are
`com.saudihomeservices.customer_app` and `com.saudihomeservices.worker_app` (unchanged).

After the first signed build, add that key's **SHA-1 and SHA-256** to the matching Android app in the Firebase console (Project settings ->
Your apps), otherwise Firebase Phone Authentication will refuse the release build (`appNotAuthorized`). If you publish through Google Play
with Play App Signing, add the **Play app-signing certificate's** fingerprints as well (Play Console -> Setup -> App signing).

## 3. Build commands

Replace the address with your real API root (HTTPS, including `/api/v1`):

```bash
# customer app
cd apps/customer_app
flutter build appbundle --release --dart-define=API_BASE_URL=https://api.example.com/api/v1
# worker app
cd apps/worker_app
flutter build appbundle --release --dart-define=API_BASE_URL=https://api.example.com/api/v1
```

Use `flutter build apk --release ...` for a sideloadable APK. Output: `build/app/outputs/bundle/release/app-release.aab` (or `flutter-apk/`).

Checks that must pass before a build is shipped:

```bash
cd packages/hs_client && flutter analyze && flutter test
cd apps/customer_app  && flutter analyze && flutter test
cd apps/worker_app    && flutter analyze && flutter test
```

Development (debug) builds need nothing extra: `flutter run` uses the emulator address; for a real device or another host pass
`--dart-define=API_BASE_URL=http://<computer-ip>:3001/api/v1`.

If the Android build stops with a Kotlin "Could not close incremental caches" error in a Firebase plugin (seen on Windows with the project
and the pub cache on different drives), build with `GRADLE_OPTS="-Dorg.gradle.project.kotlin.incremental=false"`. Nothing in the repository
needs to change for that.

## 4. iOS

* There is no debug-key shortcut on iOS: signing is `CODE_SIGN_STYLE = Automatic` in Xcode. Set your **Team** for the Runner target, and use
  a distribution certificate and provisioning profile for App Store builds.
* No ATS exception exists, so only HTTPS is reachable from a release build.
* Build: `flutter build ipa --release --dart-define=API_BASE_URL=https://api.example.com/api/v1` (needs macOS and Xcode).
* The bundle identifiers are `com.saudihomeservices.customerApp` and `com.saudihomeservices.workerApp`; they must match the iOS apps
  registered in Firebase. Push notifications also need the Push Notifications capability and an APNs key uploaded in Firebase.
* Choosing a verification document (worker app) uses the system document chooser and needs no extra Info.plist keys.

## 5. Why this is checked in tests

`packages/hs_client/test/api_base_url_test.dart` covers the address rules above. The Gradle rule was verified with
`./gradlew :app:assembleRelease --dry-run` (fails with the signing message when `key.properties` is absent) and
`:app:assembleDebug --dry-run` (unaffected). A real signed release build needs your keystore and was not made.
