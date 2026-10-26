import 'package:geolocator/geolocator.dart';

/// Where the phone's location stands. The app never needs location permission to work: every state other than [granted] leaves search and
/// moving the pin by hand available.
enum LocationAccess {
  granted,

  /// The person said no this time; asking again is allowed.
  denied,

  /// The person said "don't ask again" (or the system blocks it): only the system settings can change it.
  deniedForever,

  /// Location services are switched off on the phone.
  serviceOff,

  /// No position could be read (timeout, no hardware, no signal).
  unavailable,
}

class DeviceFix {
  const DeviceFix(this.latitude, this.longitude);
  final double latitude;
  final double longitude;
}

/// Runtime location permission and a single position read. Behind an interface so the picker is testable without the platform.
abstract class DeviceLocation {
  /// The current state without asking.
  Future<LocationAccess> status();

  /// Asks for permission when it is still askable, then reports the resulting state.
  Future<LocationAccess> request();

  /// One position fix, or null when none could be read within the time limit.
  Future<DeviceFix?> current();

  Future<void> openAppSettings();
  Future<void> openLocationSettings();
}

class GeolocatorDeviceLocation implements DeviceLocation {
  const GeolocatorDeviceLocation();

  @override
  Future<LocationAccess> status() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return LocationAccess.serviceOff;
      }
      return _map(await Geolocator.checkPermission());
    } catch (_) {
      return LocationAccess.unavailable;
    }
  }

  @override
  Future<LocationAccess> request() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return LocationAccess.serviceOff;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      return _map(permission);
    } catch (_) {
      return LocationAccess.unavailable;
    }
  }

  LocationAccess _map(LocationPermission p) => switch (p) {
    LocationPermission.always ||
    LocationPermission.whileInUse => LocationAccess.granted,
    LocationPermission.deniedForever => LocationAccess.deniedForever,
    LocationPermission.denied => LocationAccess.denied,
    LocationPermission.unableToDetermine => LocationAccess.unavailable,
  };

  @override
  Future<DeviceFix?> current() async {
    try {
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 15),
        ),
      );
      return DeviceFix(p.latitude, p.longitude);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> openAppSettings() async {
    await Geolocator.openAppSettings();
  }

  @override
  Future<void> openLocationSettings() async {
    await Geolocator.openLocationSettings();
  }
}
