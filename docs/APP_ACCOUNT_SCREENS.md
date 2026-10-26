# Customer and worker apps: where the account screens get their data

In a real build (no `DEMO_DATA`) nothing on these screens is invented. Each one reads the backend and says plainly when there is nothing, or when it could not load.

| Screen | App | Data |
|---|---|---|
| Home: greeting, initials | customer | the account's name (`/auth/me`, kept in the session) |
| Home: paid booking card | customer | `GET /bookings`: the booking under way first, then the soonest confirmed one; Track opens the booking (live map) |
| Home: bell and gold dot | customer | `GET /notifications/unread-count`; the dot shows only while it is above zero |
| Notifications list | both | `GET /notifications`, `POST /notifications/:id/read`, `read-all`. A tap marks it read and opens what it is about (booking, chat, support, application status) the same way a tapped push does |
| Services: search and category filter | customer | `GET /catalog`; the search matches name and description in both languages |
| Offers | customer | `GET /offers` (what administrators published for customers, in the customer's language). Offers are announcements: no codes, no redemptions |
| Booking detail: review | customer | `GET`/`POST /bookings/:id/review` on a completed booking: stars and comment, once; the review written is shown afterwards |
| Profile: name, initials, phone | customer | the account; **Edit** saves the name with `PATCH /customers/me` |
| Profile: My bookings, Notifications, Payment methods | customer | the number of bookings listed, unread count, and "Cash on delivery" (the only method offered) |
| Profile: Help & support | both | the person's own conversation with the support team (`/support/messages`) |
| Profile | worker | the application (`/workers/me/onboarding` + the catalog): name, status, experience, services, areas, weekly hours, documents; rating and reviews from `GET /reviews/received`; "Jobs done" from the jobs list |
| Earnings | worker | the worker's jobs (`GET /workers/me/bookings`): completed jobs add up to gross, commission and net for Today / Week / Month; the bars are the last seven Saudi days; "Pending" is what paid jobs still to do will earn; the list is the recent completed jobs |

## Not part of the platform yet (so not shown)

- Saved addresses, a payout account, withdrawals and payout history, worker subscription plans, promo codes. The screens that had them in the prototype either hide them or say so.
- Deleting an account.
- Privacy and Terms rows have no pages yet.

Times are shown in Saudi time. Amounts come from the server in halalas.
