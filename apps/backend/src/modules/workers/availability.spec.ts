import { formatMinutes, parseTime, toAvailabilityRows, toWindow } from './availability.js';

const w = (dayOfWeek: number, startTime: string, endTime: string) => ({ dayOfWeek, startTime, endTime });

describe('availability helpers', () => {
  it.each([
    ['00:00', 0],
    ['08:30', 510],
    ['23:59', 1439],
    ['24:00', 1440],
  ])('parses %s', (text, minutes) => expect(parseTime(text)).toBe(minutes));

  it.each(['8:00', '25:00', '24:01', '12:60', 'noon', '', '12-30'])('rejects %s', (text) => expect(parseTime(text)).toBeNull());

  it('formats minutes back', () => {
    expect(formatMinutes(510)).toBe('08:30');
    expect(formatMinutes(1440)).toBe('24:00');
  });

  it('converts, sorts and round-trips windows', () => {
    const rows = toAvailabilityRows([w(2, '14:00', '18:00'), w(0, '08:00', '12:00'), w(2, '08:00', '12:00')]);
    expect(rows).toEqual([
      { dayOfWeek: 0, startMinute: 480, endMinute: 720 },
      { dayOfWeek: 2, startMinute: 480, endMinute: 720 },
      { dayOfWeek: 2, startMinute: 840, endMinute: 1080 },
    ]);
    expect(toWindow(rows[0])).toEqual(w(0, '08:00', '12:00'));
  });

  it('rejects backwards, empty and malformed windows', () => {
    expect(() => toAvailabilityRows([w(1, '12:00', '08:00')])).toThrow('end after it starts');
    expect(() => toAvailabilityRows([w(1, '08:00', '08:00')])).toThrow('end after it starts');
    expect(() => toAvailabilityRows([w(1, '8am', '12:00')])).toThrow('08:00');
  });

  it('rejects overlapping or touching windows on the same day, but allows them on different days', () => {
    expect(() => toAvailabilityRows([w(1, '08:00', '12:00'), w(1, '11:00', '15:00')])).toThrow('overlap');
    expect(() => toAvailabilityRows([w(1, '08:00', '12:00'), w(1, '12:00', '15:00')])).toThrow('overlap');
    expect(() => toAvailabilityRows([w(1, '08:00', '12:00'), w(2, '08:00', '12:00')])).not.toThrow();
    expect(() => toAvailabilityRows([w(1, '08:00', '12:00'), w(1, '12:01', '15:00')])).not.toThrow();
  });
});
