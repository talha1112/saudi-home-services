"use client";

import { useMemo, useState, type ReactNode } from "react";
import { KpiGrid } from "@/components/ui/KpiGrid";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, qs, useQuery, useTotals } from "@/lib/api";
import type { Kpi, PanelData } from "@/types";
import type { Column, TableRow } from "./cells";
import { DataTable } from "./DataTable";
import { DetailPanel } from "./DetailPanel";

export interface Paged<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** A dropdown above the table. The first option is "no filter"; the others become backend query parameters. */
export interface ServerFilter {
  key: string;
  label: string;
  options: string[];
  param: (value: string) => Record<string, string | undefined>;
}

export interface PanelContext<D> {
  detail: D | null;
  reload: () => void;
  close: () => void;
}

interface Props<T, D> {
  kpis?: Kpi[];
  /** Content rendered between the KPI row and the table. */
  before?: ReactNode;
  /** `params` are sent when the tab is chosen. `count` (when set) is a list path whose total is shown on the tab. */
  tabs?: { label: string; params?: Record<string, string | undefined> }[];
  filters?: ServerFilter[];
  /** The backend list path, relative to `/admin/`. */
  path: string;
  /** Always sent (city, date window, ...). */
  params?: Record<string, string | undefined>;
  /** Sent with the search text as `q` unless this is false. */
  search?: boolean;
  columns: Column[];
  idOf: (item: T) => string;
  toRow: (item: T) => TableRow;
  action?: { label: string; icon: string; onClick: () => void };
  /** When set, an Export button downloads the matching rows (up to 500) as a CSV file with this name. */
  exportName?: string;
  footerBase: (shown: number, total: number) => string;
  detailPath?: (item: T) => string | null;
  panelFor?: (item: T, ctx: PanelContext<D>) => PanelData | null;
  /** Called when a row is clicked, for pages that show the record somewhere other than the side panel. */
  onSelect?: (item: T) => void;
  limit?: number;
  /** Shown above the table when set (a failed action, for example). */
  notice?: ReactNode;
}

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

/**
 * KPI row + optional block + a table whose rows, tab counts, search, filters and paging all come from the backend, + an optional record panel.
 * It owns the table's state (tab, filters, page, selected row); the page supplies what to ask for and how to draw a row.
 */
export function ServerTablePage<T, D = unknown>({
  kpis = [], before, tabs, filters = [], path, params = {}, search = true, columns, idOf, toRow, action, exportName, footerBase, detailPath, panelFor, onSelect, limit = 25, notice,
}: Props<T, D>) {
  const { debouncedQuery: q, version, showToast } = useAdmin();
  const [tab, setTab] = useState(0);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const filterParams = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const f of filters) {
      const v = filterValues[f.key];
      if (v && v !== f.options[0]) Object.assign(out, f.param(v));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `filters` is a constant list per page
  }, [filterValues]);

  const base = { ...params, ...(search ? { q: q || undefined } : {}) };
  const shared = JSON.stringify([tab, filterParams, base]);
  const [pageState, setPageState] = useState({ key: shared, page: 1 });
  const page = pageState.key === shared ? pageState.page : 1;

  const query = (extra: Record<string, string | number | undefined>) => qs({ ...tabs?.[tab]?.params, ...filterParams, ...base, limit, ...extra });
  const list = useQuery<Paged<T>>(`${path}?${query({ page })}`, version + reloads);
  const counts = useTotals(
    (tabs ?? []).map((t) => `${path}?${qs({ ...t.params, ...params, limit: 1 })}`),
    version + reloads,
  );

  const items = list.data?.items ?? [];
  const selItem = sel ? (items.find((i) => idOf(i) === sel) ?? null) : null;
  const detail = useQuery<D>(selItem && detailPath ? detailPath(selItem) : null, reloads);
  const total = list.data?.meta.total ?? 0;
  const reload = () => setReloads((n) => n + 1);

  async function exportCsv() {
    try {
      const rows: TableRow[] = [];
      for (let p = 1; p <= 5; p++) {
        const r = await api.get<Paged<T>>(`${path}?${query({ page: p, limit: 100 })}`);
        rows.push(...r.items.map(toRow));
        if (p >= r.meta.totalPages) break;
      }
      const lines = [columns.map((c) => csvCell(c.label)).join(","), ...rows.map((r) => r.cells.map((c) => csvCell(c.sub ? `${c.v} (${c.sub})` : c.v)).join(","))];
      const url = URL.createObjectURL(new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${exportName}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${rows.length} row${rows.length === 1 ? "" : "s"}`);
    } catch (e) {
      showToast(describeError(e));
    }
  }

  const panel = selItem && panelFor ? panelFor(selItem, { detail: detail.data, reload, close: () => setSel(null) }) : null;
  const filtersOn = filters.some((f) => filterValues[f.key] && filterValues[f.key] !== f.options[0]);

  return (
    <>
      <KpiGrid kpis={kpis} />
      {before}
      {notice}
      {list.error && (
        <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">
          {describeError(list.error)}{" "}
          <button type="button" className="font-semibold underline" onClick={list.reload}>
            Try again
          </button>
        </div>
      )}
      <DataTable
        tabs={tabs?.map((t, i) => ({ label: t.label, n: counts[i] === null ? "" : counts[i]!.toLocaleString("en-GB") }))}
        tab={tab}
        onTab={(i) => {
          setTab(i);
          setSel(null);
        }}
        filters={filters}
        filterValues={filterValues}
        onFilter={(k, v) => {
          setFilterValues((p) => ({ ...p, [k]: v }));
          setSel(null);
        }}
        onClearFilters={() => setFilterValues({})}
        action={exportName ? { label: "Export", icon: "download", onClick: () => void exportCsv() } : action}
        columns={columns}
        rows={items.map(toRow)}
        selectedKey={panelFor ? sel : undefined}
        onRowClick={
          panelFor || onSelect
            ? (k) => {
                const item = items.find((i) => idOf(i) === String(k));
                if (item) onSelect?.(item);
                if (panelFor) setSel((s) => (s === k ? null : String(k)));
              }
            : undefined
        }
        footer={list.loading && !list.data ? "Loading…" : q || filtersOn ? `${total.toLocaleString("en-GB")} ${total === 1 ? "match" : "matches"}${q ? ` “${q}”` : ""}${filtersOn ? " · filters on" : ""}` : footerBase(items.length, total)}
        pager={{ page, totalPages: list.data?.meta.totalPages ?? 1, onPage: (p) => setPageState({ key: shared, page: p }) }}
      />
      <DetailPanel data={panel} onClose={() => setSel(null)} />
    </>
  );
}
