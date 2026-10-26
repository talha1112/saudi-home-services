import 'package:hs_client/hs_client.dart';

/// Prototype data for demo builds only (`kDemoData`: a non-release build run with `--dart-define=DEMO_DATA=true`), for the prototype screens.
/// The real job screen never reads it: it shows exactly what the backend released (nothing but the city and district until the booking is
/// paid). Never add real coordinates or addresses here.
const BookingLocation devJobLocation = BookingLocation(
  cityId: 'dev-city',
  cityNameEn: 'Riyadh',
  cityNameAr: 'الرياض',
  district: 'Al Olaya',
  addressLine: 'King Fahd Rd · Bldg 12, Apt 4',
  latitude: 24.7136,
  longitude: 46.6753,
);
