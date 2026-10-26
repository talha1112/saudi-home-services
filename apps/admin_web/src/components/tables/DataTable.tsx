"use client";

import { useState } from "react";
import { Avatar, Badge } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import type { Cell, Column, FilterShape, TableRow } from "./cells";

interface DataTableProps {
  tabs?: { label: string; n: string }[];
  tab?: number;
  onTab?: (i: number) => void;
  filters?: FilterShape[];
  filterValues?: Record<string, string>;
  onFilter?: (key: string, value: string) => void;
  onClearFilters?: () => void;
  action?: { label: string; icon: string; onClick: () => void };
  columns: Column[];
  rows: TableRow[];
  selectedKey?: string | number | null;
  onRowClick?: (key: string | number) => void;
  footer: string;
  /** Real paging: the buttons below the table move between pages. Without it the pager is only a drawing. */
  pager?: { page: number; totalPages: number; onPage: (page: number) => void };
}

function CellView({ cell }: { cell: Cell }) {
  const end = cell.align === "end";
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${end ? "justify-end" : "justify-start"}`}>
      {cell.kind === "person" && <Avatar text={cell.ini ?? ""} size={32} />}
      {cell.kind === "badge" ? (
        <Badge label={cell.v} tone={cell.tone} />
      ) : (
        <div className={`flex min-w-0 flex-col gap-0.5 ${end ? "text-end" : "text-start"}`}>
          <span className={`truncate ${cell.mono ? "font-[family-name:var(--font-archivo)]" : ""}`} style={{ fontWeight: cell.fw ?? 500, color: cell.fg ?? "#172B35" }}>
            {cell.v}
          </span>
          {cell.sub && <span className="truncate text-xs text-slate">{cell.sub}</span>}
        </div>
      )}
    </div>
  );
}

/** Tabs, filter dropdowns, header row, data rows and pager inside one card. */
export function DataTable({ tabs, tab = 0, onTab, filters = [], filterValues = {}, onFilter, onClearFilters, action, columns, rows, selectedKey, onRowClick, footer, pager }: DataTableProps) {
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const grid = columns.map((c) => `minmax(0, ${c.w}fr)`).join(" ");
  const hasActive = filters.some((f) => filterValues[f.key] && filterValues[f.key] !== f.options[0]);
  const hasToolbar = !!tabs || filters.length > 0 || !!action;

  return (
    <div className="overflow-visible rounded-[18px] border border-hair bg-white">
      {hasToolbar && (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-soft px-4 py-3.5">
          <div className="flex gap-1">
            {tabs?.map((t, i) => (
              <button key={t.label} type="button" onClick={() => onTab?.(i)} className={`flex h-[34px] items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold ${i === tab ? "bg-ink text-white" : "text-slate"}`}>
                {t.label}
                <span className="text-[11.5px] opacity-70">{t.n}</span>
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {filters.map((f) => {
            const v = filterValues[f.key] || f.options[0];
            const on = v !== f.options[0];
            const open = openFilter === f.key;
            return (
              <div key={f.key} className="relative">
                <button type="button" onClick={() => setOpenFilter(open ? null : f.key)} className={`flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[10px] border-[1.5px] px-2.5 text-[12.5px] ${on || open ? "border-[#9cc5ba]" : "border-line"} ${on ? "bg-tint" : "bg-white"}`}>
                  <span className="text-slate">{f.label}</span>
                  <b className={`font-semibold ${on ? "text-brand" : "text-ink"}`}>{v}</b>
                  <Icon name={open ? "chevron-up" : "chevron-down"} size={14} />
                </button>
                {open && (
                  <div className="absolute right-0 top-10 z-50 flex max-h-[300px] min-w-[200px] flex-col gap-0.5 overflow-y-auto rounded-[14px] border border-line bg-white p-1.5 shadow-[0_14px_40px_rgba(23,43,53,.16)]">
                    {f.options.map((o) => (
                      <button key={o} type="button" onClick={() => { onFilter?.(f.key, o); setOpenFilter(null); }} className={`flex h-9 items-center gap-2 whitespace-nowrap rounded-[9px] px-2.5 text-start text-[13px] hover:bg-[#f3f8f7] ${o === v ? "bg-tint font-bold text-brand" : "font-medium"}`}>
                        <span className="flex-1">{o}</span>
                        {o === v && <Icon name="check" size={15} strokeWidth={2.6} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {hasActive && (
            <button type="button" onClick={onClearFilters} className="h-[34px] rounded-[10px] px-2.5 text-[12.5px] font-semibold text-brand">
              Clear
            </button>
          )}
          {action && (
            <button type="button" onClick={action.onClick} className="flex h-[34px] items-center gap-1.5 rounded-[10px] bg-brand px-3.5 text-[13px] font-semibold text-white">
              <Icon name={action.icon} size={15} />
              {action.label}
            </button>
          )}
        </div>
      )}
      <div className="grid gap-3 border-b border-soft bg-[#fafbfc] px-4 py-2.5 text-[11.5px] font-bold uppercase tracking-[.04em] text-slate" style={{ gridTemplateColumns: grid }}>
        {columns.map((c) => (
          <div key={c.label} className={c.align === "end" ? "text-end" : "text-start"}>
            {c.label}
          </div>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.key} onClick={() => onRowClick?.(r.key)} className={`grid cursor-pointer items-center gap-3 border-b border-faint px-4 py-[11px] text-[13.5px] ${selectedKey === r.key ? "bg-[#f3f8f7]" : "bg-white"}`} style={{ gridTemplateColumns: grid }}>
          {r.cells.map((c, i) => (
            <CellView key={i} cell={c} />
          ))}
        </div>
      ))}
      {rows.length === 0 && <div className="px-4 py-10 text-center text-[13.5px] text-slate">No rows match the current filters.</div>}
      <div className="flex items-center justify-between px-4 py-3 text-[12.5px] text-slate">
        <span>{footer}</span>
        <div className="flex gap-1.5">
          <PageButton disabled={!pager || pager.page <= 1} onClick={() => pager?.onPage(pager.page - 1)}>
            <Icon name="chevron-left" size={15} />
          </PageButton>
          <PageButton current>{pager?.page ?? 1}</PageButton>
          {(!pager || pager.page < pager.totalPages) && (
            <PageButton disabled={!pager} onClick={() => pager?.onPage(pager.page + 1)}>
              {(pager?.page ?? 1) + 1}
            </PageButton>
          )}
          <PageButton disabled={!pager || pager.page >= pager.totalPages} onClick={() => pager?.onPage(pager.page + 1)}>
            <Icon name="chevron-right" size={15} />
          </PageButton>
        </div>
      </div>
    </div>
  );
}

function PageButton({ children, current, disabled, onClick }: { children: React.ReactNode; current?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled || current}
      onClick={onClick}
      className={`grid size-[30px] place-items-center rounded-[9px] ${current ? "bg-ink font-semibold text-white" : "border border-line"} ${disabled && !current ? "opacity-45" : ""}`}
    >
      {children}
    </button>
  );
}
