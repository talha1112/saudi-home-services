# Worker onboarding, admin review and support

## The path

1. **Sign in** (phone and SMS code through Firebase). The backend decides where the worker belongs from their application status: an approved worker goes to the dashboard, a worker with a pending application sees the status screen, anyone else sees the application.
2. **Application** (4 steps, every step is saved to the backend before moving on, and the form is filled from what the server already has):
   1. **Personal details**: profile photo (required, JPEG or PNG), full name, Arabic name, years of experience, short introduction. The photo is stored as a `PHOTO` document by the same signed upload the documents use.
   2. **Services and cities**, from the backend catalog.
   3. **Availability** (days and one daily window).
   4. **Documents**: one identity document (National ID or Iqama) is required; certificate and license are optional. Then **Submit for review**.
3. **Admin panel → Worker Verification**: the queue, the full application (contact, photo, services, cities, availability, every document with *View / Accept / Reject*, history) and the actions *Start review, Approve, Request more info, Reject*. Every action is audited.
4. **The worker's status screen** shows the decision and the reviewer's note (`INFO_REQUIRED` and `REJECTED` allow editing and resubmitting). The app reloads the status on opening and when it comes back to the foreground.
5. **Support**: any worker who is not approved (submitted, under review, info required, rejected, suspended) has a *Contact support* button on the status screen. It opens the same chat screen used for bookings, as a conversation with the administrators. Customers can use the same endpoints.
6. **Admin panel → Support**: all conversations (those needing a reply first), who is writing (name, phone, role and, for a worker, the application status), the full thread, *Send reply* and *Mark resolved / Reopen*. The worker sees the reply in the app within a few seconds while the chat is open. A new message from the person reopens a resolved conversation.

## API added in this phase

| Who | Endpoint | Notes |
| --- | --- | --- |
| Customer / worker | `GET /support/messages?afterSeq=` | their own conversation; empty until the first message |
| Customer / worker | `POST /support/messages` `{clientMessageId, body}` | 1-2000 characters; a retry with the same id is stored once; 10 per minute |
| Admin | `GET /admin/support/threads?status=&search=` | paged |
| Admin | `GET /admin/support/threads/:id` | thread plus who it is from |
| Admin | `POST /admin/support/threads/:id/reply` `{body, clientMessageId?}` | status becomes `ANSWERED` |
| Admin | `POST /admin/support/threads/:id/resolve` and `/reopen` | |

Database: migration `20261103090000_support_threads` (two new tables and one enum, nothing existing is touched).

## Push notifications to the worker

| Event | Push | Tapping it opens |
| --- | --- | --- |
| An administrator replies to the worker's support message | "Support replied" (`support.reply`) | the support conversation |
| An administrator starts a review, approves, rejects, asks for more information, suspends or reinstates | `verification.*` | the application status screen |

* The push is queued in the same database transaction as the reply or the decision, so it exists only if the action was stored, and a retried reply or repeated action never notifies twice. It carries a title and a fixed sentence only: never the text of the reply and never the reviewer's note (those are read in the app).
* **App closed or in the background:** Android shows the notification itself and tapping it opens the right screen. **App open:** a bar appears at the bottom with an *Open* button, and the status screen refreshes by itself.
* A worker with no registered phone (notifications refused) still gets the in-app notification; nothing is queued for push.

### What is needed for a phone to actually receive it

The code is complete and tested with a fake push provider. Delivery to a real phone needs the backend to talk to Firebase Cloud Messaging, which needs a **service-account key for the Firebase project** that only you can download (Firebase console → Project settings → Service accounts → Generate new private key). Then in `apps/backend/.env`:

```
PUSH_PROVIDER=fcm
FIREBASE_SERVICE_ACCOUNT_BASE64=<the key file, base64-encoded on one line>
```

(`FIREBASE_PROJECT_ID` and `DEVICE_TOKEN_ENCRYPTION_KEY` are already set for the development backend.) Restart the backend. Keep `FCM_DRY_RUN=true` first to validate the credentials without delivering. Without the key, notifications are still created and shown in the app's notification list, and their push deliveries are recorded as UNSUPPORTED.

## Running it for real (a phone against your own computer)

1. Backend: a PostgreSQL database with **all** migrations applied (`npm run db:migrate:deploy` for your database; `home_services_test` is already current), `DOCUMENT_STORAGE=local` with `STORAGE_LOCAL_DIR` and a `STORAGE_SIGNING_SECRET` of at least 32 characters (otherwise uploads answer 503), the catalog seeded (`npm run db:seed`), an administrator (`ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run admin:bootstrap`). Reach it from the phone through your computer's address, not `localhost`.
2. Admin panel: `apps/admin_web` (`npm run dev`), signed in as that administrator.
3. Worker app: `flutter run --dart-define=API_BASE_URL=http://<computer-address>:3001/api/v1`, with the Maps key set up as in `GOOGLE_MAPS_SETUP.md`. Do not pass `DEMO_DATA`.

### Walk-through

1. Sign in on the phone as a new worker; complete the four steps (take or pick a photo in step 1) and submit.
2. Admin panel → Worker Verification: the applicant appears with their photo, services, cities, availability and documents. View a document, then *Request more info* with a note.
3. Phone: the status screen shows "We need a little more information" and your note. Tap *Edit application*, fix, resubmit.
4. In the admin panel *Reject*, then on the phone tap *Contact support* and write a message.
5. Admin panel → Support: the conversation is at the top with the worker's application status. Reply. The reply appears on the phone.
6. Admin panel → *Approve*. The phone's status screen (reopen it or bring the app to the foreground) offers *Go to dashboard*.

## Before this is exposed to real people

* **HTTPS everywhere**, a real `API_BASE_URL`, `NODE_ENV=production`; release builds refuse an http address.
* **Storage**: `DOCUMENT_STORAGE=s3` with a private bucket. No malware scanner is integrated (`FILE_SCANNER=disabled`): identity documents are served unscanned unless you add one or accept that explicitly (see `apps/backend/docs/FILE_LIFECYCLE.md`).
* **Firebase** production project and SHA fingerprints, **SMS** quotas.
* **Admin accounts**: change the bootstrap password, enable the controls in `PRODUCTION_HARDENING.md`.
* **Support** is polling-based (the worker app checks every 3 seconds while the screen is open, the admin page every 10 seconds); there is no push notification when an administrator replies while the app is closed, and nobody is alerted by email when a worker writes. Support staff beyond the single admin role (permissions, assignment, response-time targets) are a product decision.
