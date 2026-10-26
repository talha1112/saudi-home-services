"use client";

import { useQuery } from "@/lib/api";

export interface CategoryItem {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  iconKey: string | null;
  isActive: boolean;
}

export interface ServiceItem {
  id: string;
  categoryId: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  isActive: boolean;
}

export interface CatalogStats {
  services: { serviceId: string; bookings: number; completedBookings: number; workers: number; averageQuoteHalalas: number | null }[];
  categories: { categoryId: string; bookings: number; workers: number }[];
}

export interface PricingSetting {
  id: string;
  vatRateBps: number;
  commissionRateBps: number;
  minServiceChargeHalalas: number;
  isProvisional: boolean;
  note: string | null;
  effectiveFrom: string;
}

/** The icon names the admin's icon set has for the category keys the catalogue uses. */
export const categoryIcon = (key: string | null): string => (key === "bolt" ? "zap" : key && ["zap", "droplet", "snowflake"].includes(key) ? key : "sliders");

/** Categories, services, their statistics and the current pricing, reloaded whenever `refresh` changes. */
export function useCatalog(refresh = 0) {
  const categories = useQuery<{ items: CategoryItem[] }>("service-categories?limit=100", refresh);
  const services = useQuery<{ items: ServiceItem[] }>("services?limit=100", refresh);
  const stats = useQuery<CatalogStats>("catalog-stats", refresh);
  const pricing = useQuery<PricingSetting>("pricing-settings/current", refresh);
  return { categories, services, stats, pricing };
}

/** A URL-safe slug from an English name: "Ceiling Fan Installation" becomes "ceiling-fan-installation". */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return s.length >= 2 ? s : `service-${Math.random().toString(36).slice(2, 8)}`;
}
