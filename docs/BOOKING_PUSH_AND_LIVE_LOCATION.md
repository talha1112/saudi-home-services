# Booking pushes, chat pushes and the live worker location

## Push events (booking flow and chat)

Each is a row in `notifications` (idempotent per user + source key) with one push per registered device. The push carries `notificationId`, `type`, `resourceType`, `resourceId` (the booking id). No chat text and no phone numbers are ever in a push.

| Event | Who is notified | `type` |
|---|---|---|
| Request created | Approved workers who offer the service in the booking's city | `request.new` |
| Quote received / revised | Customer | `quote.received` |
| Quote accepted | Assigned worker | `quote.accepted` |
| Quote rejected | The quoting worker | `quote.rejected` |
| Payment confirmed (cash chosen or card paid) | Customer and worker | `payment.confirmed` |
| Work started / completed | Customer | `work.started`, `work.completed` |
| Cancelled | Customer and worker | `booking.cancelled` |
| Expired | Customer | `booking.expired` |
| Chat message | The other side | `chat.message` (one push per run of unread messages) |

In the apps: with the app open a bar shows the title with an Open action and the bookings list refreshes; tapping a system notification opens the booking (or the chat for `chat.message`). Open booking and job screens also re-read the booking every 6 s (customer) / 8 s (worker), so a status change appears without leaving the screen.

## Live worker location

- The worker app (foreground only) sends a position every 10 s through `POST /workers/me/bookings/:id/location` while the job is `IN_PROGRESS`, or `CONFIRMED` and starting within 3 h. Approved workers only; location permission is asked when a job needs it.
- The server keeps the latest position only (Redis, short TTL) and checks plausibility and rate; it stops sharing when the job is no longer active.
- The customer app reads `GET /bookings/:id/location` every 5 s on a paid booking and draws the worker and the address on Google Maps. It never draws a position the server did not send; it says "waiting", "appears shortly before the visit", or "last seen" instead.

## Needs to be configured

- Redis (`REDIS_URL`) for positions; `LOCATION_SHARING_LEAD_MINUTES` (default 180) and `LOCATION_MIN_INTERVAL_MS`.
- Google Maps keys per `GOOGLE_MAPS_SETUP.md`; FCM as in `WORKER_ONBOARDING_AND_SUPPORT.md`.

## Not covered

Sharing stops when the worker app is in the background (no foreground service yet). Everything here is tested against fakes and the test database; nothing was run on a physical device, with real FCM delivery, or with real Google Maps rendering.
