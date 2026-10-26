"use client";

import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import type { PanelData } from "@/types";

/** Right-hand record detail, portaled into the shell's panel slot. */
export function DetailPanel({ data, onClose }: { data: PanelData | null; onClose: () => void }) {
  const { panelSlot } = useAdmin();
  if (!panelSlot || !data) return null;
  return createPortal(
    <div className="flex min-h-full flex-col">
      <div className="flex items-start gap-3.5 border-b border-soft p-5">
        <div className="grid size-[52px] shrink-0 place-items-center rounded-2xl bg-tint text-[17px] font-bold text-brand">{data.ini}</div>
        <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <div className="text-[17px] font-bold">{data.title}</div>
          <div className="text-[12.5px] text-slate">{data.sub}</div>
          <div className="flex flex-wrap gap-1.5">
            {data.badges.map((b) => (
              <Badge key={b.l} label={b.l} tone={b.tone} className="!rounded-[7px] !px-2 !py-[3px] !text-[11.5px]" />
            ))}
          </div>
        </div>
        <button type="button" aria-label="Close panel" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-line bg-white">
          <Icon name="x" size={15} />
        </button>
      </div>
      {data.stats && (
        <div className="grid grid-cols-3 border-b border-soft">
          {data.stats.map((s) => (
            <div key={s.k} className="flex flex-col gap-[3px] border-r border-soft px-4 py-3.5 last:border-r-0">
              <span className="whitespace-nowrap text-[17px] font-bold">{s.v}</span>
              <span className="text-[11.5px] text-slate">{s.k}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-1 flex-col px-5 pb-5 pt-1.5">
        {data.sections.map((sec) => (
          <div key={sec.t} className="flex flex-col gap-[9px] border-b border-soft py-4">
            <div className="text-[11.5px] font-bold uppercase tracking-[.06em] text-slate">{sec.t}</div>
            {sec.rows.map(([k, v, c]) => (
              <div key={k} className="flex justify-between gap-3 text-[13.5px]">
                <span className="text-slate">{k}</span>
                <span className="text-end font-semibold" style={{ color: c }}>{v}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-soft px-5 py-4">
        {data.actions.map((a, i) => (
          <button
            key={a.l}
            type="button"
            onClick={a.onClick}
            className={`flex h-11 items-center justify-center gap-2 rounded-[13px] text-sm font-semibold ${a.danger ? "border-[1.5px] border-danger-line bg-white text-danger" : i === 0 ? "bg-brand text-white" : "border-[1.5px] border-line bg-white text-ink"}`}
          >
            <Icon name={a.icon} size={16} />
            {a.l}
          </button>
        ))}
      </div>
    </div>,
    panelSlot,
  );
}
