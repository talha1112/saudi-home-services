"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useAdmin } from "@/lib/admin-context";
import { MONTHS, TODAY, addDays, daysBetween, rangeLabel, toDate, toIso } from "@/lib/format";

const MONTH_START = `${TODAY.slice(0, 8)}01`;
const LAST_MONTH_END = addDays(MONTH_START, -1);
const PRESETS: [string, string, string][] = [
  ["Today", TODAY, TODAY],
  ["Yesterday", addDays(TODAY, -1), addDays(TODAY, -1)],
  ["Last 7 days", addDays(TODAY, -6), TODAY],
  ["Last 30 days", addDays(TODAY, -29), TODAY],
  ["This month", MONTH_START, TODAY],
  ["Last month", `${LAST_MONTH_END.slice(0, 8)}01`, LAST_MONTH_END],
  ["Year to date", `${TODAY.slice(0, 4)}-01-01`, TODAY],
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const BASE_MONTH = Number(TODAY.slice(0, 4)) * 12 + Number(TODAY.slice(5, 7)) - 1;

interface Pending {
  from: string;
  to: string | null;
}

/** Date-range button with a preset list and a single-month calendar popover. */
export function DateRangePicker() {
  const { range, setRange } = useAdmin();
  const [open, setOpen] = useState(false);
  const [pend, setPend] = useState<Pending>(range);
  const [monthOffset, setMonthOffset] = useState(0);

  const toggle = () => {
    setPend(range);
    setMonthOffset(0);
    setOpen((o) => !o);
  };

  const mIdx = BASE_MONTH + monthOffset;
  const year = Math.floor(mIdx / 12);
  const month = mIdx % 12;
  const lead = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const a = pend.from;
  const b = pend.to ?? pend.from;

  const pickDay = (iso: string) => {
    if (iso > TODAY) return;
    if (pend.to === null) {
      setPend(iso < pend.from ? { from: iso, to: pend.from } : { from: pend.from, to: iso });
    } else {
      setPend({ from: iso, to: null });
    }
  };

  return (
    <div className="relative shrink-0">
      <button type="button" onClick={toggle} className={`flex h-10 items-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3 text-[13px] font-semibold ${open ? "border-[#9cc5ba] bg-tint" : "border-line bg-white"}`}>
        <Icon name="calendar" size={16} />
        {rangeLabel(range.from, range.to)}
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-[46px] z-[60] flex w-[580px] flex-col rounded-[18px] border border-line bg-white shadow-[0_18px_50px_rgba(23,43,53,.18)]">
          <div className="grid grid-cols-[170px_minmax(0,1fr)]">
            <div className="flex flex-col gap-0.5 border-r border-soft p-3">
              {PRESETS.map(([label, from, to]) => {
                const on = a === from && b === to;
                return (
                  <button
                    key={label}
                    type="button"
                    className={`h-9 rounded-[9px] px-2.5 text-start text-[13px] font-semibold ${on ? "bg-tint text-brand" : "text-ink"}`}
                    onClick={() => {
                      setPend({ from, to });
                      const m = toDate(to);
                      setMonthOffset(m.getUTCFullYear() * 12 + m.getUTCMonth() - BASE_MONTH);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex items-center justify-between">
                <button type="button" aria-label="Previous month" onClick={() => setMonthOffset((m) => m - 1)} className="grid size-8 place-items-center rounded-[9px] border border-line bg-white">
                  <Icon name="chevron-left" size={15} />
                </button>
                <b className="text-[14.5px]">{MONTHS[month]} {year}</b>
                <button type="button" aria-label="Next month" disabled={monthOffset >= 0} onClick={() => setMonthOffset((m) => m + 1)} className={`grid size-8 place-items-center rounded-[9px] border border-line bg-white ${monthOffset >= 0 ? "opacity-40" : ""}`}>
                  <Icon name="chevron-right" size={15} />
                </button>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center text-[11.5px] font-bold text-muted">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="py-1">{w}</span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-y-0.5">
                {Array.from({ length: lead }, (_, i) => (
                  <span key={`l${i}`} />
                ))}
                {Array.from({ length: dayCount }, (_, i) => {
                  const iso = toIso(new Date(Date.UTC(year, month, i + 1)));
                  const future = iso > TODAY;
                  const inRange = iso >= a && iso <= b;
                  const isEdge = iso === a || iso === b;
                  const radius = iso === a && iso === b ? "10px" : iso === a ? "10px 0 0 10px" : iso === b ? "0 10px 10px 0" : inRange ? "0" : "10px";
                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={future}
                      onClick={() => pickDay(iso)}
                      className={`h-9 text-[13px] ${isEdge ? "bg-brand font-bold text-white" : inRange ? "bg-tint" : ""} ${future ? "cursor-not-allowed text-muted opacity-45" : ""}`}
                      style={{ borderRadius: radius, boxShadow: iso === TODAY && !isEdge ? "inset 0 0 0 1.5px #F4B740" : undefined }}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 border-t border-soft px-4 py-3">
            <div className="flex flex-1 flex-col gap-px">
              <span className="text-[11.5px] text-slate">{pend.to ? `${daysBetween(pend.from, pend.to)} days selected` : "Pick an end date"}</span>
              <b className="text-[13.5px]">{pend.to ? rangeLabel(pend.from, pend.to) : `${rangeLabel(pend.from, pend.from)} – …`}</b>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="h-[38px] rounded-[11px] border border-line bg-white px-3.5 text-[13px] font-semibold">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setRange({ from: pend.from, to: pend.to ?? pend.from });
                setOpen(false);
              }}
              className="h-[38px] rounded-[11px] bg-brand px-4 text-[13px] font-semibold text-white"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
