/// The time a worker offers to come, derived from what the customer asked for.
///
/// The backend refuses a proposed start that is already in the past, and an urgent request's start is only minutes after it was created,
/// so a start that has passed (or is about to) is moved to a short while from now. The length of the customer's window is kept. This is
/// resolved when the quote is SENT, not when the screen opened.
({DateTime start, DateTime end}) proposedWindow({
  required DateTime? preferredStart,
  required DateTime? preferredEnd,
  required DateTime now,
  Duration lead = const Duration(minutes: 15),
  Duration fallbackLength = const Duration(hours: 2),
}) {
  final nowUtc = now.toUtc();
  final earliest = nowUtc.add(lead);
  var start = preferredStart?.toUtc() ?? earliest;
  var length = (preferredEnd != null && preferredStart != null)
      ? preferredEnd.difference(preferredStart)
      : fallbackLength;
  if (length <= Duration.zero) length = fallbackLength;
  if (start.isBefore(earliest)) {
    // round up to the next whole minute so the value is tidy
    start = DateTime.utc(
      earliest.year,
      earliest.month,
      earliest.day,
      earliest.hour,
      earliest.minute +
          (earliest.second > 0 || earliest.millisecond > 0 ? 1 : 0),
    );
  }
  return (start: start, end: start.add(length));
}

/// SAR as typed ("120", "120.5", "١٢٠") to whole halalas, or null if it is not a positive amount with at most two decimals.
int? parsePriceHalalas(String input) {
  var text = input.trim();
  if (text.isEmpty) return null;
  // Arabic-Indic digits
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  text = text
      .split('')
      .map((c) {
        final i = arabic.indexOf(c);
        return i >= 0 ? '$i' : c;
      })
      .join()
      .replaceAll('٫', '.')
      .replaceAll(',', '.');
  final match = RegExp(r'^(\d{1,9})(?:\.(\d{1,2}))?$').firstMatch(text);
  if (match == null) return null;
  final whole = int.parse(match.group(1)!);
  final frac = (match.group(2) ?? '').padRight(2, '0');
  final halalas = whole * 100 + int.parse(frac.isEmpty ? '0' : frac);
  return halalas > 0 ? halalas : null;
}
