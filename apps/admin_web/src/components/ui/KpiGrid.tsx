import type { Kpi } from "@/types";
import { Icon } from "./Icon";

const ICON_TONE = {
  gold: "bg-cream text-[#b07a10]",
  red: "bg-danger-bg text-danger",
  default: "bg-tint text-brand",
};

/** Row of headline metric cards (up to five columns). */
export function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  if (kpis.length === 0) return null;
  const cols = Math.min(kpis.length, 5);
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {kpis.map((k) => (
        <div key={k.k} className="flex flex-col gap-2 rounded-2xl border border-hair bg-white p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-slate">{k.k}</span>
            <span className={`grid size-[30px] place-items-center rounded-[9px] ${ICON_TONE[k.tone ?? "default"]}`}>
              <Icon name={k.icon} size={15} />
            </span>
          </div>
          <div className="whitespace-nowrap text-2xl font-bold tracking-[-0.01em]">{k.v}</div>
          <div className="flex items-center gap-1 text-xs font-semibold" style={{ color: k.dc ?? "#00695C" }}>
            {k.d}
          </div>
        </div>
      ))}
    </div>
  );
}
