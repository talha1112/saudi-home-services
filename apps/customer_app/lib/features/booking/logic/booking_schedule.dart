/// Turning what the customer picks (a day and a start time, or "as soon as possible") into the two timestamps the backend needs
/// (`preferredStartAt`, `preferredEndAt`, ISO 8601). Pure functions with an injected clock, so every rule is testable.
///
/// Saudi Arabia is UTC+3 all year (no daylight saving), so days and start times are read in that fixed offset whatever the phone's own
/// time zone is. The backend remains the judge of the rules (`INVALID_SCHEDULE`): the constants below only keep the app from offering
/// times it already knows will be refused.
library;

const Duration kSaudiOffset = Duration(hours: 3);

/// Mirrors the backend's default `BOOKING_MIN_LEAD_MINUTES`. If the server's value is higher, it answers INVALID_SCHEDULE and the screen
/// shows its message.
const int kMinLeadMinutes = 30;

/// Extra margin so a time that is valid when picked is still valid when the request reaches the server.
const int kLeadMarginMinutes = 10;

/// How many days ahead the picker offers (the backend allows more; a week is what the screen shows).
const int kDaysOffered = 7;

/// Start hours (24 h, Saudi time) offered each day. Each is a two-hour arrival window.
const List<int> kSlotStartHours = [9, 11, 13, 16, 18, 20];
const int kWindowHours = 2;

/// One offered day. [date] is the calendar date in Saudi time, held as a UTC midnight only to carry year/month/day.
class DayOption {
  const DayOption(this.date, {required this.isToday});
  final DateTime date;
  final bool isToday;

  /// 1 = Monday ... 7 = Sunday.
  int get weekday => date.weekday;
  int get dayOfMonth => date.day;
}

/// The current Saudi calendar date and time, as a UTC-flagged DateTime whose fields read as Saudi local time.
DateTime saudiNow(DateTime nowUtc) => nowUtc.toUtc().add(kSaudiOffset);

List<DayOption> upcomingDays(DateTime nowUtc, {int count = kDaysOffered}) {
  final local = saudiNow(nowUtc);
  final today = DateTime.utc(local.year, local.month, local.day);
  return [
    for (var i = 0; i < count; i++)
      DayOption(today.add(Duration(days: i)), isToday: i == 0),
  ];
}

/// The instant (UTC) a slot starts: the day's date at [startHour] Saudi time.
DateTime slotStartUtc(DayOption day, int startHour) => DateTime.utc(
  day.date.year,
  day.date.month,
  day.date.day,
  startHour,
).subtract(kSaudiOffset);

/// Whether the slot starts late enough to be accepted.
bool slotAvailable(
  DayOption day,
  int startHour,
  DateTime nowUtc, {
  int leadMinutes = kMinLeadMinutes + kLeadMarginMinutes,
}) => slotStartUtc(
  day,
  startHour,
).isAfter(nowUtc.toUtc().add(Duration(minutes: leadMinutes)));

/// The chosen window, ready to send.
class BookingWindow {
  const BookingWindow({
    required this.start,
    required this.end,
    required this.isUrgent,
  });
  final DateTime start;
  final DateTime end;
  final bool isUrgent;
}

enum ScheduleProblem {
  /// Nothing chosen yet.
  notChosen,

  /// The chosen time can no longer be booked (it has passed or is too soon).
  tooSoon,
}

class ScheduleResult {
  const ScheduleResult.ok(BookingWindow this.window) : problem = null;
  const ScheduleResult.problem(ScheduleProblem this.problem) : window = null;
  final BookingWindow? window;
  final ScheduleProblem? problem;
}

/// Resolves the choice at the moment of submitting, not when it was picked, so "as soon as possible" is always fresh and a slot that has
/// since become too soon is caught before the request is sent.
ScheduleResult resolveWindow({
  required bool asap,
  required int dayIndex,
  required int slotIndex,
  required DateTime nowUtc,
  int leadMinutes = kMinLeadMinutes + kLeadMarginMinutes,
}) {
  final now = nowUtc.toUtc();
  if (asap) {
    final raw = now.add(Duration(minutes: leadMinutes));
    final start = DateTime.utc(
      raw.year,
      raw.month,
      raw.day,
      raw.hour,
      raw.minute + (raw.second > 0 || raw.millisecond > 0 ? 1 : 0),
    );
    return ScheduleResult.ok(
      BookingWindow(
        start: start,
        end: start.add(const Duration(hours: kWindowHours)),
        isUrgent: true,
      ),
    );
  }
  final days = upcomingDays(now);
  if (dayIndex < 0 ||
      dayIndex >= days.length ||
      slotIndex < 0 ||
      slotIndex >= kSlotStartHours.length) {
    return const ScheduleResult.problem(ScheduleProblem.notChosen);
  }
  final day = days[dayIndex];
  final hour = kSlotStartHours[slotIndex];
  if (!slotAvailable(day, hour, now, leadMinutes: leadMinutes)) {
    return const ScheduleResult.problem(ScheduleProblem.tooSoon);
  }
  final start = slotStartUtc(day, hour);
  return ScheduleResult.ok(
    BookingWindow(
      start: start,
      end: start.add(const Duration(hours: kWindowHours)),
      isUrgent: false,
    ),
  );
}

/// "9:00 AM" / "9:00 ص" for a start hour.
String slotLabel(int startHour, {required bool arabic}) {
  final h12 = startHour % 12 == 0 ? 12 : startHour % 12;
  final suffix = startHour < 12 ? (arabic ? 'ص' : 'AM') : (arabic ? 'م' : 'PM');
  return '$h12:00 $suffix';
}

/// "Today · 6:00 PM" style label for the header, or the "as soon as possible" text.
String whenText({
  required bool asap,
  required int dayIndex,
  required int slotIndex,
  required DateTime nowUtc,
  required bool arabic,
}) {
  if (asap) return arabic ? 'في أقرب وقت' : 'As soon as possible';
  final days = upcomingDays(nowUtc);
  if (dayIndex < 0 ||
      dayIndex >= days.length ||
      slotIndex < 0 ||
      slotIndex >= kSlotStartHours.length) {
    return '';
  }
  final d = days[dayIndex];
  final day = d.isToday
      ? (arabic ? 'اليوم' : 'Today')
      : weekdayName(d.weekday, arabic: arabic);
  final slot = slotLabel(kSlotStartHours[slotIndex], arabic: arabic);
  return arabic ? '$day $slot' : '$day · $slot';
}

String weekdayName(int weekday, {required bool arabic}) {
  const en = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ar = ['اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت', 'أحد'];
  return (arabic ? ar : en)[(weekday - 1) % 7];
}
