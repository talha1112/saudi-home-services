# Customer booking flow

The customer app creates real booking requests through the NestJS backend. Nothing in this path is mocked in a normal or release build.

## Path

1. **Catalog**: `GET /catalog` (public) is loaded when the app starts. Services carry the backend UUIDs; cities come from the same response.
2. **Location step**: the customer picks a city (backend city id) and confirms a place on the map (`PickedLocation`).
3. **Schedule step**: seven Saudi-time days, six two-hour windows, or "as soon as possible". Times that are already too soon are disabled.
4. **Details step**: a description of 10 to 2000 characters. Photos are not offered, because `POST /bookings` has nowhere to put them.
5. **Send**: `POST /bookings` (customer access token) with `serviceId`, `cityId`, `problemDescription`, `preferredStartAt`, `preferredEndAt` (ISO 8601 UTC), `isUrgent` and `PickedLocation.toBookingFields()` (`addressLine`, `district`, `building`, `locationNotes`, numeric `latitude` and `longitude`).
6. **Confirmation**: built from the response (reference, status, window). It leads to the Bookings tab, which lists `GET /bookings`.

The booking is created as `OPEN`. Workers then send quotes; the customer accepts one and only then does the backend create a payment.

## Choosing a quote and paying

Tapping a booking in the Bookings tab opens its details (`GET /bookings/:id`):

* **OPEN**: the quotes workers sent (`GET /bookings/:id/quotes`). "Choose this quote" asks for confirmation, then `POST /bookings/:id/quotes/:quoteId/accept` with only the quote's version (`expectedVersion`), never a price. If the worker changed the quote meanwhile the server answers 409 `QUOTE_CHANGED` and the new price is shown.
* **PAYMENT_PENDING**: the agreed price, VAT and total from the server, and "Pay now" (`POST /bookings/:id/payments` with an `Idempotency-Key`, no amount). A retry after a lost answer reuses the key, so it is the same payment.
* **CONFIRMED and later**: "Paid and confirmed" and the worker's phone. The app treats a booking as paid ONLY when the server reports CONFIRMED; opening a checkout page or getting a payment object back proves nothing.

## Payment methods

After choosing a quote the customer sees how to pay:

| Method | State |
| --- | --- |
| **Cash** | Available. `POST /bookings/:id/payments/cash` confirms the booking at once (status CONFIRMED, `paymentMethod = CASH`); the customer pays the agreed total to the worker in person. The worker then sees the address, the exact point and the customer's phone, starts the job, and confirms receiving the cash (`POST /workers/me/bookings/:id/cash-collected`). Repeating either call changes nothing. |
| Card (mada / Visa / Mastercard), Apple Pay, STC Pay | Shown greyed out as **Coming soon**; they cannot be chosen. |

Cash records no payment attempt and no ledger entry: how cash is accounted, and the platform commission on it, are open business decisions. A booking confirmed as cash counts as confirmed everywhere the backend looks at `confirmedAt`.

The backend's online payment endpoint (`POST /bookings/:id/payments`, provider `disabled` or the development `mock`) still exists and is covered by its own tests, but the app does not offer it until a provider is chosen. `docs/dev/simulate-payment.mjs` only matters for that path.

## Duplicates

`POST /bookings` has no idempotency key, so the app protects itself:

* taps while a request is running share it (one request);
* once a booking exists the screen returns it and never sends again;
* if an attempt ended with no answer (connection lost, 5xx) the next attempt first asks `GET /bookings?status=OPEN&createdFrom=...` and adopts a matching booking (same service, city and window) instead of sending again. If that check cannot be made, nothing is sent.

## Demo data

The old prototype screens (fake prices and ratings, workers, quotes, payment, tracking, offers, sample bookings) exist only with `--dart-define=DEMO_DATA=true`. It is off by default.

```
flutter test                                  # real behaviour
flutter test --dart-define=DEMO_DATA=true     # also renders the prototype screens
```

## Running it for real

* a backend reachable from the phone (`API_BASE_URL`), on a database with all migrations applied;
* catalog seeded (`seed-catalog.cli`) with at least one active service and city;
* a signed-in customer.
