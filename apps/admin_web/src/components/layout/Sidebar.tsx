"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { sessionApi, type SessionUser } from "@/lib/api";
import { NAV } from "@/lib/nav";
import { initials } from "@/lib/workers-api";

export function Sidebar() {
  const pathname = usePathname();
  const [me, setMe] = useState<SessionUser | null>(null);
  useEffect(() => {
    sessionApi.me().then(setMe).catch(() => undefined);
  }, []);
  const name = me?.fullName ?? me?.email ?? "Administrator";
  return (
    <aside className="flex w-[248px] shrink-0 flex-col overflow-y-auto bg-ink text-white">
      <div className="flex items-center gap-2.5 px-5 pb-[18px] pt-[22px]">
        <div className="grid size-[38px] place-items-center rounded-xl bg-brand">
          <Icon name="wrench" size={19} />
        </div>
        <div className="flex flex-col gap-px">
          <div className="text-[15px] font-bold">Home Services</div>
          <div className="text-[11.5px] font-semibold tracking-[.04em] text-gold">SUPER ADMIN</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-3 pb-5 pt-1">
        {NAV.map((group) => (
          <div key={group.head} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-bold uppercase tracking-[.1em] text-white/45">{group.head}</div>
            {group.items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex h-[38px] items-center gap-[11px] rounded-[10px] px-2.5 text-[13.5px] ${active ? "bg-white/10 font-semibold text-white" : "font-medium text-white/70"}`}
                >
                  <Icon name={item.icon} size={17} />
                  <span className="flex-1">{item.label}</span>
                  {item.badge ? (
                    <span className="grid h-5 min-w-5 place-items-center rounded-[10px] bg-gold px-1.5 text-[11px] font-extrabold text-ink">{item.badge}</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex items-center gap-2.5 border-t border-white/10 px-5 py-4">
        <div className="grid size-[34px] place-items-center rounded-[11px] bg-gold text-[13px] font-bold text-ink">{initials(me?.fullName ?? me?.email ?? null, "A")}</div>
        <div className="flex min-w-0 flex-col gap-px">
          <div className="truncate text-[13px] font-semibold">{name}</div>
          <div className="text-[11.5px] text-white/60">Super admin</div>
        </div>
      </div>
    </aside>
  );
}
