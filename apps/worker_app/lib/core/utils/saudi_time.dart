/// Times the backend sends are UTC instants; people in Saudi Arabia read them in Arabia Standard Time (UTC+3, no daylight saving), whatever
/// time zone the phone is set to.
const Duration kSaudiOffset = Duration(hours: 3);

DateTime _saudi(DateTime t) => t.toUtc().add(kSaudiOffset);

String _clock(DateTime saudi, {required bool arabic}) {
  final h12 = saudi.hour % 12 == 0 ? 12 : saudi.hour % 12;
  final mm = saudi.minute.toString().padLeft(2, '0');
  final suffix = saudi.hour < 12
      ? (arabic ? 'ص' : 'AM')
      : (arabic ? 'م' : 'PM');
  return '$h12:$mm $suffix';
}

String _day(DateTime saudi, DateTime nowSaudi, {required bool arabic}) {
  bool sameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;
  if (sameDay(saudi, nowSaudi)) return arabic ? 'اليوم' : 'Today';
  if (sameDay(saudi, nowSaudi.add(const Duration(days: 1)))) {
    return arabic ? 'غداً' : 'Tomorrow';
  }
  const en = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ar = ['اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت', 'أحد'];
  final name = (arabic ? ar : en)[(saudi.weekday - 1) % 7];
  return '$name ${saudi.day}/${saudi.month}';
}

/// "Today · 6:00 PM" for a moment.
String whenLabel(DateTime? at, {required bool arabic, DateTime? now}) {
  if (at == null) return '';
  final t = _saudi(at);
  return '${_day(t, _saudi(now ?? DateTime.now()), arabic: arabic)} · ${_clock(t, arabic: arabic)}';
}

/// "Today · 6:00 PM – 8:00 PM" for a window.
String windowLabel(
  DateTime? start,
  DateTime? end, {
  required bool arabic,
  DateTime? now,
}) {
  if (start == null) return '';
  final s = _saudi(start);
  final day = _day(s, _saudi(now ?? DateTime.now()), arabic: arabic);
  final from = _clock(s, arabic: arabic);
  if (end == null) return '$day · $from';
  return '$day · $from – ${_clock(_saudi(end), arabic: arabic)}';
}
