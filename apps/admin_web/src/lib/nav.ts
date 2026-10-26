export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
}

export interface NavGroup {
  head: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { head: "Overview", items: [
    { href: "/dashboard", label: "Dashboard", icon: "grid" },
    { href: "/reports", label: "Reports", icon: "chart" },
  ] },
  { head: "People", items: [
    { href: "/customers", label: "Customers", icon: "users" },
    { href: "/workers", label: "Workers", icon: "wrench" },
    { href: "/verification", label: "Worker Verification", icon: "shield" },
    { href: "/support", label: "Support", icon: "message" },
  ] },
  { head: "Operations", items: [
    { href: "/services", label: "Services", icon: "sliders" },
    { href: "/bookings", label: "Bookings", icon: "calendar" },
    { href: "/quotes", label: "Quotes", icon: "file" },
    { href: "/disputes", label: "Disputes", icon: "alert" },
    { href: "/reviews", label: "Reviews", icon: "star" },
  ] },
  { head: "Finance", items: [
    { href: "/payments", label: "Payments", icon: "card" },
    { href: "/commissions", label: "Commissions", icon: "percent" },
    { href: "/subscriptions", label: "Subscriptions", icon: "refresh" },
  ] },
  { head: "Growth", items: [
    { href: "/offers", label: "Offers", icon: "gift" },
    { href: "/notifications", label: "Notifications", icon: "bell" },
  ] },
  { head: "System", items: [{ href: "/settings", label: "Settings", icon: "settings" }] },
];

export function metaFor(pathname: string) {
  for (const g of NAV) {
    const item = g.items.find((i) => pathname.startsWith(i.href));
    if (item) return { title: item.label, group: g.head };
  }
  return { title: "", group: "" };
}
