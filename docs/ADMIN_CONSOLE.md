# Admin console: where every screen gets its data

Every number, row, filter and search on the admin web comes from the backend database through the web app's own server (the BFF: the browser never sees a token). The admin web keeps no data of its own.

## Screens and their endpoints (all `ADMIN` only, under `/api/v1/admin/`)

| Screen | Endpoints |
|---|---|
| Header: cities, search, date range | `cities`, `search?q=` (customers, workers, bookings, services, disputes), the range is sent to every page as `from`/`to` (Riyadh calendar days) |
| Dashboard | `dashboard` (KPIs, trend, categories, cities, weekly money, top workers, queues) |
| Reports | `report-series` (6-month chart per city), `report-series/summary`, `report-series/cities`; CSV is built in the browser from what is on screen, PDF opens the browser's print dialog |
| Customers | `customers`, `customers/summary`, `customers/:id`, `users/:id/suspend` and `reactivate` |
| Workers, Worker Verification, Support | `workers…`, `support/threads…` (unchanged) |
| Services | `services`, `service-categories`, `catalog-stats`, `pricing-settings/current` |
| Bookings | `bookings` (search `q`, status, service, worker, payment method, city, dates), `bookings/:id`, `bookings/:id/cancel`, refund via `payments/:id/refunds` |
| Quotes | `quotes`, `quotes/summary` |
| Disputes | `disputes` (several statuses, city, dates, `q`), `disputes/:id` and its actions (`start-review`, `request-info`, `resolve`, `close`) |
| Reviews | `reviews` (status, stars, city, dates, `q`), `reports/reviews` |
| Payments | `transactions?view=transactions|refunds|failed`, `transactions/summary`, `refunds/:id/cancel` |
| Commissions | `commissions`, `commissions/workers`, `pricing-settings` (the Edit rules dialog) |
| Subscriptions | no data exists (see below) |
| Offers | `offers` (phase, `q`), create and publish |
| Notifications | `notifications` (history), `notifications/summary`, `notifications/reach`, `notifications/broadcast` |
| Settings | `admins`, `system`, `pricing-settings/current`, `notifications/summary` |

## What the platform does not have (and the screens say so)

- **Worker subscriptions / plans**: every worker is on the single commission rate. The Subscriptions screen shows zero paid plans; the Plan filters have one real value.
- **Per-service minimum charge, commission override, duration**: pricing is platform-wide (Edit commission rules). Services show the platform values.
- **Offer discounts, codes, redemptions**: offers are announcements. The discount typed in the form is stored as the offer's ribbon text.
- **Payouts to workers, invoices, scheduling an announcement, reassigning a professional**: not built. The buttons stay and answer with a plain message.
- **Refunds**: a refund is a request until a payment provider confirms it; none can yet. The Payments and Bookings screens say "Request refund".
- **Administrator accounts** are created with the command-line tool, so Settings lists them read-only.

## Definitions worth knowing

- Revenue = total (incl. VAT) of bookings *completed* in the chosen dates; commission and worker earnings are the amounts stored on each booking when its quote was accepted.
- A booking paid online is a confirmed booking that is not cash (only cash is stored on the booking).
- "Spent" for a customer = total of their completed bookings.
- Announcements go to at most 5,000 people at once, one notification each (and a push to every registered phone). "Opened" = read in the app.
