import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

/// What the person has typed or chosen in the application form. It is only a draft: nothing counts until the server accepted it, and the
/// form is filled from the server's copy (`seed`) so an application can be continued or corrected later.
class ApplyDraft extends ChangeNotifier {
  final fullName = TextEditingController();
  final fullNameAr = TextEditingController();
  final bio = TextEditingController();
  final years = TextEditingController();
  final Set<String> services = {};
  final Set<String> cities = {};
  final Set<int> days = {};
  TimeOfDay from = const TimeOfDay(hour: 8, minute: 0);
  TimeOfDay to = const TimeOfDay(hour: 17, minute: 0);

  bool _seeded = false;

  /// Copies the server's saved application into the form, once.
  void seed(WorkerOnboarding data) {
    if (_seeded) return;
    _seeded = true;
    fullName.text = data.profile.fullName ?? '';
    fullNameAr.text = data.profile.fullNameAr ?? '';
    bio.text = data.profile.bio ?? '';
    years.text = data.profile.yearsOfExperience?.toString() ?? '';
    services
      ..clear()
      ..addAll(data.serviceIds);
    cities
      ..clear()
      ..addAll(data.cityIds);
    days
      ..clear()
      ..addAll(data.availability.map((w) => w.dayOfWeek));
    if (data.availability.isNotEmpty) {
      from = parseTime(data.availability.first.startTime) ?? from;
      to = parseTime(data.availability.first.endTime) ?? to;
    }
    notifyListeners();
  }

  int? get yearsValue {
    final v = int.tryParse(years.text.trim());
    return v != null && v >= 0 && v <= 60 ? v : null;
  }

  bool get profileValid =>
      fullName.text.trim().length >= 2 && yearsValue != null;
  bool get areaValid => services.isNotEmpty && cities.isNotEmpty;
  bool get hoursValid => minutes(from) < minutes(to);
  bool get availabilityValid => days.isNotEmpty && hoursValid;

  List<AvailabilityWindow> get windows => [
    for (final d in (days.toList()..sort()))
      AvailabilityWindow(
        dayOfWeek: d,
        startTime: format(from),
        endTime: format(to),
      ),
  ];

  void toggleService(String id) => _change(
    () => services.contains(id) ? services.remove(id) : services.add(id),
  );
  void toggleCity(String id) =>
      _change(() => cities.contains(id) ? cities.remove(id) : cities.add(id));
  void toggleDay(int d) =>
      _change(() => days.contains(d) ? days.remove(d) : days.add(d));
  void setFrom(TimeOfDay t) => _change(() => from = t);
  void setTo(TimeOfDay t) => _change(() => to = t);
  void touch() => notifyListeners();

  void _change(VoidCallback fn) {
    fn();
    notifyListeners();
  }

  static int minutes(TimeOfDay t) => t.hour * 60 + t.minute;

  /// 24-hour `HH:mm`, the format the backend expects.
  static String format(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  static TimeOfDay? parseTime(String value) {
    final m = RegExp(r'^(\d{2}):(\d{2})$').firstMatch(value);
    if (m == null) return null;
    final h = int.parse(m.group(1)!);
    final min = int.parse(m.group(2)!);
    return h > 23 || min > 59 ? null : TimeOfDay(hour: h, minute: min);
  }

  @override
  void dispose() {
    fullName.dispose();
    fullNameAr.dispose();
    bio.dispose();
    years.dispose();
    super.dispose();
  }
}
