/**
 * Launch reference data. It is only used by `npm run db:seed`, which creates MISSING rows
 * (matched by slug) and never overwrites what an admin has since edited. Nothing in the
 * application logic refers to these slugs: categories, services and cities are managed
 * through the admin API.
 */
export const SEED_CITIES = [
  { slug: 'riyadh', nameEn: 'Riyadh', nameAr: 'الرياض', sortOrder: 1 },
  { slug: 'jeddah', nameEn: 'Jeddah', nameAr: 'جدة', sortOrder: 2 },
  { slug: 'dammam', nameEn: 'Dammam', nameAr: 'الدمام', sortOrder: 3 },
] as const;

export const SEED_CATEGORIES = [
  {
    slug: 'electrical',
    nameEn: 'Electrical',
    nameAr: 'الكهرباء',
    descriptionEn: 'Wiring, lighting, sockets and electrical panels.',
    descriptionAr: 'التمديدات والإضاءة والأفياش ولوحات الكهرباء.',
    iconKey: 'bolt',
    sortOrder: 1,
    services: [
      { slug: 'electrical-wiring-outlets', nameEn: 'Wiring and outlets', nameAr: 'تمديدات وأفياش كهربائية', sortOrder: 1 },
      { slug: 'lighting-installation', nameEn: 'Lighting installation', nameAr: 'تركيب الإضاءة', sortOrder: 2 },
      { slug: 'breaker-panel-repair', nameEn: 'Breaker and panel repair', nameAr: 'إصلاح القواطع ولوحات الكهرباء', sortOrder: 3 },
    ],
  },
  {
    slug: 'plumbing',
    nameEn: 'Plumbing',
    nameAr: 'السباكة',
    descriptionEn: 'Leaks, drains, fixtures and water heaters.',
    descriptionAr: 'التسربات والمجاري والتركيبات وسخانات المياه.',
    iconKey: 'droplet',
    sortOrder: 2,
    services: [
      { slug: 'leak-repair', nameEn: 'Leak repair', nameAr: 'إصلاح التسربات', sortOrder: 1 },
      { slug: 'drain-unclogging', nameEn: 'Drain unclogging', nameAr: 'تسليك المجاري', sortOrder: 2 },
      { slug: 'water-heater-service', nameEn: 'Water heater service', nameAr: 'صيانة سخانات المياه', sortOrder: 3 },
    ],
  },
  {
    slug: 'air-conditioning',
    nameEn: 'Air Conditioning',
    nameAr: 'التكييف',
    descriptionEn: 'AC installation, repair, cleaning and gas refill.',
    descriptionAr: 'تركيب وصيانة وتنظيف المكيفات وتعبئة الفريون.',
    iconKey: 'snowflake',
    sortOrder: 3,
    services: [
      { slug: 'ac-installation', nameEn: 'AC installation', nameAr: 'تركيب المكيفات', sortOrder: 1 },
      { slug: 'ac-repair', nameEn: 'AC repair', nameAr: 'صيانة وإصلاح المكيفات', sortOrder: 2 },
      { slug: 'ac-cleaning-refill', nameEn: 'AC cleaning and gas refill', nameAr: 'تنظيف المكيفات وتعبئة الفريون', sortOrder: 3 },
    ],
  },
] as const;

/**
 * PROVISIONAL development pricing: VAT 15%, commission 15%, minimum service charge SAR 50.
 * These are placeholders so the booking flow can be exercised; they are NOT confirmed business
 * rules. Inserted only when no pricing exists at all, and marked is_provisional = true.
 * Replace them through POST /api/v1/admin/pricing-settings once the business confirms the figures.
 */
export const SEED_PRICING = {
  vatRateBps: 1500,
  commissionRateBps: 1500,
  minServiceChargeHalalas: 5000,
  isProvisional: true,
  note: 'PROVISIONAL development values - not confirmed by the business. Replace via the admin pricing API.',
} as const;
