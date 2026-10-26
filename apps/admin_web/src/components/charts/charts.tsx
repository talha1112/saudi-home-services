/** Dual-line area chart (bookings booked vs completed). */
export function LineChart({ series, xLabels }: { series: [number[], number[]]; xLabels: string[] }) {
  const max = Math.max(1, ...series[0], ...series[1]);
  const pts = (a: number[]) => a.map((v, i) => `${Math.round((i * 680) / Math.max(1, a.length - 1))},${Math.round(185 - (v / max) * 165)}`).join(" ");
  const l1 = pts(series[0]);
  return (
    <>
      <svg viewBox="0 0 680 210" className="block h-[210px] w-full" role="img" aria-label="Bookings over time">
        {[20, 75, 130].map((y) => (
          <line key={y} x1="0" y1={y} x2="680" y2={y} stroke="#EEF2F4" />
        ))}
        <line x1="0" y1="185" x2="680" y2="185" stroke="#E3E8EC" />
        <polygon points={`0,185 ${l1} 680,185`} fill="rgba(0,105,92,.08)" />
        <polyline points={l1} fill="none" stroke="#00695C" strokeWidth="2.5" strokeLinejoin="round" />
        <polyline points={pts(series[1])} fill="none" stroke="#F4B740" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
      <div className="-mt-1.5 flex justify-between text-[11.5px] text-slate">
        {xLabels.map((x) => (
          <span key={x}>{x}</span>
        ))}
      </div>
    </>
  );
}

export interface BarGroup {
  label: string;
  /** Heights in percent, one per series. */
  values: number[];
}

/** Grouped vertical bars; `colors` has one entry per series. */
export function GroupedBars({ groups, colors, height = 170, gap = 14 }: { groups: BarGroup[]; colors: string[]; height?: number; gap?: number }) {
  return (
    <div className="flex items-end pt-2" style={{ height, gap }}>
      {groups.map((g) => (
        <div key={g.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <div className="flex h-full w-full items-end gap-[3px]">
            {g.values.map((v, i) => (
              <div key={i} className="flex-1 rounded-t-[5px]" style={{ height: `${v}%`, background: colors[i] }} />
            ))}
          </div>
          <span className="text-[11px] text-slate">{g.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string; round?: boolean }[] }) {
  return (
    <div className="flex gap-4 text-xs text-slate">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className={i.round ? "h-[3px] w-2.5 rounded-sm" : "size-2.5 rounded-[3px]"} style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function ProgressBar({ pct, height = 8, className = "" }: { pct: number | string; height?: number; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-full bg-soft ${className}`} style={{ height }}>
      <div className="h-full rounded-full bg-brand" style={{ width: typeof pct === "number" ? `${pct}%` : pct }} />
    </div>
  );
}
