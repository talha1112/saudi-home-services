import { AdminProvider } from "@/lib/admin-context";
import { AppShell } from "@/components/layout/AppShell";

/** Everything behind sign-in: the admin frame (sidebar, header, detail panel). The proxy sends signed-out visitors to /login. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminProvider>
      <AppShell>{children}</AppShell>
    </AdminProvider>
  );
}
