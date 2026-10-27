"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useAdmin } from "@/lib/admin-context";
import { api, sessionApi, type SessionUser } from "@/lib/api";
import { metaFor } from "@/lib/nav";
import type { CityFilter } from "@/types";
import { DateRangePicker } from "./DateRangePicker";

interface SearchResult {
  type: string;
  icon: string;
  title: string;
  sub: string;
  href: string;
  /** What to put in the search box so the page opens already filtered to this record. */
  term: string;
}

interface Hit {
  type: "customer" | "worker" | "booking" | "service" | "dispute";
  id: string;
  title: string;
  subtitle: string;
}

const KIND: Record<Hit["type"], { label: string; icon: string; href: string }> = {
  customer: { label: "Customer", icon: "user", href: "/customers" },
  worker: { label: "Worker", icon: "wrench", href: "/workers" },
  booking: { label: "Booking", icon: "calendar", href: "/bookings" },
  service: { label: "Service", icon: "sliders", href: "/services" },
  dispute: { label: "Dispute", icon: "alert", href: "/disputes" },
};

/** The header search: asks the backend for a few matches of each kind once typing pauses. */
function useSearchResults(q: string) {
  const text = q.trim();
  const [state, setState] = useState<{ text: string; results: SearchResult[] } | null>(null);
  useEffect(() => {
    if (text.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .get<{ hits: Hit[] }>(`search?q=${encodeURIComponent(text)}`)
        .then((r) => {
          if (live) setState({ text, results: r.hits.map((h) => ({ type: KIND[h.type].label, icon: KIND[h.type].icon, title: h.title, sub: h.subtitle, href: KIND[h.type].href, term: h.type === "booking" ? h.title.split(" · ")[0]! : h.type === "dispute" ? h.title.replace("Dispute · ", "") : h.title })) });
        })
        .catch(() => {
          if (live) setState({ text, results: [] });
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text]);
  return { results: state && state.text === text ? state.results : [], searching: text.length >= 2 && (!state || state.text !== text) };
}

export function Header() {
  const { city, setCity, cities, query, setQuery } = useAdmin();
  const [me, setMe] = useState<SessionUser | null>(null);
  useEffect(() => {
    sessionApi.me().then(setMe).catch(() => undefined); // a 401 here sends the browser to /login
  }, []);
  async function signOut() {
    await sessionApi.logout().catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }
  const router = useRouter();
  const pathname = usePathname();
  const meta = metaFor(pathname);
  const [focused, setFocused] = useState(false);
  const { results, searching } = useSearchResults(query);
  const open = focused && query.trim().length > 0;
  const cityTabs: { value: CityFilter; label: string }[] = [{ value: "all", label: "All cities" }, ...cities.map((c) => ({ value: c.id, label: c.nameEn }))];

  return (
    <header className="flex h-[72px] shrink-0 items-center gap-4 border-b border-line bg-white px-7">
      <div className="flex shrink-0 flex-col gap-0.5 whitespace-nowrap">
        <div className="text-xs text-slate">Admin · {meta.group}</div>
        <div className="text-xl font-bold">{meta.title}</div>
      </div>

      <div className="relative min-w-[160px] max-w-[300px] flex-1">
        <div className={`flex h-10 items-center gap-2 rounded-xl border-[1.5px] pl-3 pr-2 text-slate ${focused ? "border-brand bg-white" : "border-transparent bg-faint"}`}>
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search bookings, workers, customers…"
            className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-ink"
          />
          {query && (
            <button type="button" aria-label="Clear search" onMouseDown={(e) => { e.preventDefault(); setQuery(""); }} className="grid size-6 place-items-center rounded-[7px] border-none bg-line text-ink">
              <Icon name="x" size={13} strokeWidth={2.4} />
            </button>
          )}
        </div>
        {open && (
          <div className="absolute left-0 top-[46px] z-[60] flex w-[420px] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_18px_50px_rgba(23,43,53,.18)]">
            {results.slice(0, 8).map((r) => (
              <button key={r.type + r.title + r.sub} type="button" onMouseDown={() => { setQuery(r.term); setFocused(false); router.push(r.href); }} className="flex w-full items-center gap-3 border-b border-faint bg-white px-3.5 py-2.5 text-start hover:bg-[#f3f8f7]">
                <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-tint text-brand">
                  <Icon name={r.icon} size={16} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <b className="truncate text-[13.5px] font-semibold">{r.title}</b>
                  <span className="truncate text-xs text-slate">{r.sub}</span>
                </span>
                <span className="shrink-0 rounded-[7px] bg-soft px-2 py-[3px] text-[11px] font-bold text-[#334155]">{r.type}</span>
              </button>
            ))}
            {results.length === 0 && <div className="px-4 py-[22px] text-center text-[13.5px] text-slate">{searching ? "Searching…" : `No matches for “${query}”`}</div>}
            <div className="flex justify-between bg-[#fafbfc] px-3.5 py-[9px] text-[11.5px] text-slate">
              <span>{results.length ? `${results.length} result${results.length > 1 ? "s" : ""}${results.length > 8 ? " · showing 8" : ""}` : "Try a name, phone or booking ID"}</span>
              <span>Enter filters this table · Esc clears</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 gap-0.5 whitespace-nowrap rounded-xl bg-soft p-[3px]">
        {cityTabs.map((c) => (
          <button key={c.value} type="button" onClick={() => setCity(c.value)} className={`h-[34px] rounded-[9px] px-3 text-[13px] font-semibold ${city === c.value ? "bg-white text-ink shadow-[0_1px_3px_rgba(23,43,53,.12)]" : "text-slate"}`}>
            {c.label}
          </button>
        ))}
      </div>

      <DateRangePicker />

      <button type="button" aria-label="Notifications" onClick={() => router.push("/notifications")} className="relative grid size-10 place-items-center rounded-xl border border-line bg-white">
        <Icon name="bell" size={18} />
      </button>
      <div className="flex items-center gap-2.5">
        <span className="whitespace-nowrap text-[13px] font-semibold">{me?.fullName ?? "Administrator"}</span>
        <button type="button" onClick={signOut} className="h-10 shrink-0 rounded-xl border border-line bg-white px-3 text-[13px] font-semibold">
          Sign out
        </button>
      </div>
    </header>
  );
}
