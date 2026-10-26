"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { TODAY, addDays, rangeToIso } from "@/lib/format";
import type { CityFilter } from "@/types";

export type ModalName = "service" | "rules" | null;

export interface CityOption {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
}

interface AdminState {
  /** "all" or a city id (from the database). */
  city: CityFilter;
  setCity: (c: CityFilter) => void;
  /** The cities that exist (active), for the city tabs and for filters. */
  cities: CityOption[];
  range: { from: string; to: string };
  setRange: (r: { from: string; to: string }) => void;
  /** The chosen range as the ISO window the backend takes (from inclusive, to exclusive), Riyadh calendar days. */
  span: { from: string; to: string };
  query: string;
  setQuery: (q: string) => void;
  /** The search text once typing paused: pages send this to the backend. */
  debouncedQuery: string;
  modal: ModalName;
  openModal: (m: ModalName) => void;
  /** Changes whenever something an open page lists was changed from a dialog, so pages reload. */
  version: number;
  bump: () => void;
  toast: string | null;
  /** DOM node where pages render their right-hand detail panel. */
  panelSlot: HTMLElement | null;
  setPanelSlot: (el: HTMLElement | null) => void;
  showToast: (t: string) => void;
}

const Ctx = createContext<AdminState | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [city, setCity] = useState<CityFilter>("all");
  const [cities, setCities] = useState<CityOption[]>([]);
  const [range, setRange] = useState({ from: addDays(TODAY, -29), to: TODAY });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [modal, openModal] = useState<ModalName>(null);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((t: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(t);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let live = true;
    api
      .get<{ items: CityOption[] }>("cities?isActive=true&limit=100")
      .then((r) => {
        if (live) setCities(r.items);
      })
      .catch(() => undefined); // a 401 sends the browser to /login; otherwise the city tabs just stay on "All cities"
    return () => {
      live = false;
    };
  }, [version]);

  const span = useMemo(() => rangeToIso(range), [range]);

  const value = useMemo<AdminState>(
    () => ({ city, setCity, cities, range, setRange, span, query, setQuery, debouncedQuery, modal, openModal, version, bump, toast, panelSlot, setPanelSlot, showToast }),
    [city, cities, range, span, query, debouncedQuery, modal, version, bump, toast, panelSlot, showToast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAdmin must be used inside AdminProvider");
  return v;
}
