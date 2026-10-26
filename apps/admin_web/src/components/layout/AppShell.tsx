"use client";

import { Icon } from "@/components/ui/Icon";
import { AdminModals } from "@/components/modals/AdminModals";
import { useAdmin } from "@/lib/admin-context";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

/** Fixed admin frame: sidebar, header, scrolling main area and a detail-panel slot. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { setPanelSlot, toast } = useAdmin();
  return (
    <div className="relative flex h-screen min-w-[1280px] overflow-hidden bg-background text-ink">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-7 pb-10 pt-6">{children}</main>
          <div ref={setPanelSlot} className="w-[380px] shrink-0 overflow-y-auto border-l border-line bg-white empty:hidden" />
        </div>
      </div>
      <AdminModals />
      {toast && (
        <div className="fixed bottom-7 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-2.5 rounded-[14px] bg-ink px-[18px] py-3 text-[13.5px] font-semibold text-white shadow-[0_14px_40px_rgba(23,43,53,.3)]">
          <span className="flex text-gold">
            <Icon name="check" size={16} strokeWidth={2.6} />
          </span>
          {toast}
        </div>
      )}
    </div>
  );
}
