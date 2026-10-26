import { badRequest } from '../../common/errors/api-error.js';

export interface AvailabilityWindowInput {
  /** 0 = Sunday ... 6 = Saturday (Saudi week). */
  dayOfWeek: number;
  /** "HH:mm" in Saudi local time. */
  startTime: string;
  /** "HH:mm"; "24:00" means end of day. */
  endTime: string;
}

export interface AvailabilityRow {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

const TIME = /^(\d{2}):(\d{2})$/;

export function parseTime(value: string): number | null {
  const match = TIME.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (mins > 59 || hours > 24 || minutes > 1440) return null;
  return minutes;
}

export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Validates weekly windows and converts them to minute offsets. Rejects bad times, windows that
 * end before they start, and windows that overlap or touch on the same day (merge them instead).
 */
export function toAvailabilityRows(windows: AvailabilityWindowInput[]): AvailabilityRow[] {
  const rows: AvailabilityRow[] = windows.map((w) => {
    const start = parseTime(w.startTime);
    const end = parseTime(w.endTime);
    if (start === null || end === null) {
      throw badRequest('INVALID_AVAILABILITY', 'Times must look like 08:00 (24-hour clock)');
    }
    if (start >= end) {
      throw badRequest('INVALID_AVAILABILITY', 'Each window must end after it starts');
    }
    return { dayOfWeek: w.dayOfWeek, startMinute: start, endMinute: end };
  });

  const sorted = [...rows].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.dayOfWeek === cur.dayOfWeek && cur.startMinute <= prev.endMinute) {
      throw badRequest('INVALID_AVAILABILITY', 'Windows on the same day must not overlap or touch; merge them');
    }
  }
  return sorted;
}

export function toWindow(row: AvailabilityRow): AvailabilityWindowInput {
  return { dayOfWeek: row.dayOfWeek, startTime: formatMinutes(row.startMinute), endTime: formatMinutes(row.endMinute) };
}
