import 'package:customer_app/features/booking/logic/booking_schedule.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // 2026-11-01 22:30 UTC is already 01:30 on 2 November in Saudi Arabia (UTC+3).
  final lateNight = DateTime.utc(2026, 11, 1, 22, 30);

  group('days', () {
    test(
      'are Saudi calendar days, starting today, even when the UTC date is still yesterday',
      () {
        final days = upcomingDays(lateNight);
        expect(days, hasLength(7));
        expect(days.first.date, DateTime.utc(2026, 11, 2));
        expect(days.first.isToday, isTrue);
        expect(days.last.date, DateTime.utc(2026, 11, 8));
        expect(days.skip(1).any((d) => d.isToday), isFalse);
      },
    );

    test('weekday names (Monday = 1)', () {
      expect(weekdayName(1, arabic: false), 'Mon');
      expect(weekdayName(7, arabic: false), 'Sun');
      expect(weekdayName(6, arabic: true), 'سبت');
    });
  });

  group('slots', () {
    test(
      'a slot starts at its Saudi hour, three hours before the same UTC clock hour',
      () {
        final day = upcomingDays(lateNight).first; // 2 Nov
        expect(slotStartUtc(day, 9), DateTime.utc(2026, 11, 2, 6));
        expect(slotStartUtc(day, 20), DateTime.utc(2026, 11, 2, 17));
      },
    );

    test(
      'is available only if it starts after now plus the lead time and margin',
      () {
        final day = upcomingDays(DateTime.utc(2026, 11, 2, 5)).first;
        // 05:00 UTC = 08:00 Saudi. The 09:00 slot (06:00 UTC) is 60 minutes away: allowed with a 40-minute lead.
        expect(slotAvailable(day, 9, DateTime.utc(2026, 11, 2, 5)), isTrue);
        // at 05:30 UTC it is only 30 minutes away: refused
        expect(
          slotAvailable(day, 9, DateTime.utc(2026, 11, 2, 5, 30)),
          isFalse,
        );
        // exactly at the lead boundary is not enough (it must be strictly later)
        expect(
          slotAvailable(day, 9, DateTime.utc(2026, 11, 2, 5, 20)),
          isFalse,
        );
        expect(slotAvailable(day, 9, DateTime.utc(2026, 11, 2, 5, 19)), isTrue);
        // tomorrow's slots are always fine
        expect(
          slotAvailable(
            upcomingDays(DateTime.utc(2026, 11, 2, 5))[1],
            9,
            DateTime.utc(2026, 11, 2, 5),
          ),
          isTrue,
        );
      },
    );
  });

  group('resolveWindow', () {
    test('a chosen slot becomes a two-hour window in UTC, not urgent', () {
      final now = DateTime.utc(2026, 11, 1, 10);
      final r = resolveWindow(
        asap: false,
        dayIndex: 1,
        slotIndex: 4,
        nowUtc: now,
      ); // day 2 Nov + 1 = 3 Nov?
      final w = r.window!;
      // today (Saudi) is 1 Nov 13:00; dayIndex 1 is 2 Nov; slot 4 is 18:00 Saudi = 15:00 UTC
      expect(w.start, DateTime.utc(2026, 11, 2, 15));
      expect(w.end, DateTime.utc(2026, 11, 2, 17));
      expect(w.isUrgent, isFalse);
      expect(w.start.isUtc, isTrue);
    });

    test(
      'as soon as possible starts after the lead time (rounded up to the minute), lasts two hours and is urgent',
      () {
        final now = DateTime.utc(2026, 11, 1, 10, 0, 20);
        final w = resolveWindow(
          asap: true,
          dayIndex: 0,
          slotIndex: -1,
          nowUtc: now,
        ).window!;
        expect(
          w.start,
          DateTime.utc(2026, 11, 1, 10, 41),
        ); // +40 minutes, rounded up
        expect(w.end, DateTime.utc(2026, 11, 1, 12, 41));
        expect(w.isUrgent, isTrue);
        expect(
          w.start.difference(now) > const Duration(minutes: kMinLeadMinutes),
          isTrue,
        );
      },
    );

    test(
      'a slot that has become too soon is caught before anything is sent',
      () {
        final r = resolveWindow(
          asap: false,
          dayIndex: 0,
          slotIndex: 0,
          nowUtc: DateTime.utc(2026, 11, 2, 5, 45),
        ); // 09:00 Saudi slot, 15 min away
        expect(r.window, isNull);
        expect(r.problem, ScheduleProblem.tooSoon);
      },
    );

    test('nothing chosen, or an index out of range, is "not chosen"', () {
      for (final c in [(0, -1), (-1, 2), (7, 2), (0, 99)]) {
        final r = resolveWindow(
          asap: false,
          dayIndex: c.$1,
          slotIndex: c.$2,
          nowUtc: DateTime.utc(2026, 11, 1),
        );
        expect(r.problem, ScheduleProblem.notChosen, reason: '$c');
      }
    });

    test(
      'the ISO strings the API receives are UTC with a Z, not local offsets',
      () {
        final w = resolveWindow(
          asap: false,
          dayIndex: 2,
          slotIndex: 1,
          nowUtc: DateTime.utc(2026, 11, 1, 10),
        ).window!;
        expect(w.start.toIso8601String(), endsWith('Z'));
        expect(w.end.toIso8601String(), endsWith('Z'));
      },
    );
  });

  group('labels', () {
    test('slot labels', () {
      expect(slotLabel(9, arabic: false), '9:00 AM');
      expect(slotLabel(13, arabic: false), '1:00 PM');
      expect(slotLabel(20, arabic: true), '8:00 م');
      expect(slotLabel(12, arabic: false), '12:00 PM');
    });

    test('the header text', () {
      final now = DateTime.utc(2026, 11, 1, 10);
      expect(
        whenText(
          asap: true,
          dayIndex: 0,
          slotIndex: -1,
          nowUtc: now,
          arabic: false,
        ),
        'As soon as possible',
      );
      expect(
        whenText(
          asap: false,
          dayIndex: 0,
          slotIndex: 4,
          nowUtc: now,
          arabic: false,
        ),
        'Today · 6:00 PM',
      );
      expect(
        whenText(
          asap: false,
          dayIndex: 1,
          slotIndex: 4,
          nowUtc: now,
          arabic: true,
        ),
        'اثنين 6:00 م',
      );
      expect(
        whenText(
          asap: false,
          dayIndex: 0,
          slotIndex: -1,
          nowUtc: now,
          arabic: false,
        ),
        '',
      );
    });
  });
}
