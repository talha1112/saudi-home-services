# Deploying to Render, step by step

`render.yaml` in the repository root creates four things in your Render account: a PostgreSQL 17 database, a Key Value (Redis) store, the API (`homeservices-api`) and the admin web (`homeservices-admin`). Plans in the file are paid ones (database Basic 256 MB, services Starter, Key Value Starter): the free plans sleep and the free database is deleted after 30 days, which is a bad surprise in front of a client. Check the current prices on Render's pricing page.

## 1. Put the code on GitHub
1. Create an empty **private** repository on GitHub.
2. In the project folder: `git add -A`, `git commit -m "Initial commit"`, then the two commands GitHub shows you (`git remote add origin ...`, `git push -u origin main`).
3. Check on GitHub that no `.env`, `*.jks`, `key.properties`, `maps.local.json` or `google-services.json` was uploaded (`.gitignore` already excludes them).

## 2. Create the blueprint
1. Sign in at render.com and connect your GitHub account when asked.
2. **New → Blueprint**, choose the repository, branch `main`. Render reads `render.yaml` and lists the four resources.
3. It then asks for the values that are not in the file (the `sync: false` ones). Fill in:

| Variable | Service | What to put |
|---|---|---|
| `DATABASE_URL` | api | leave empty for now, filled in step 3 |
| `REDIS_URL` | api | leave empty for now, filled in step 3 |
| `CORS_ORIGINS` | api | leave empty for now, filled in step 4 |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | api | base64 of the Firebase service-account JSON. Firebase console → Project settings → Service accounts → Generate new private key. In PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`. Then delete the downloaded file. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | api | the same values as in your local `.env` |
| `BACKEND_API_URL` | admin | leave empty for now, filled in step 4 |

4. Click **Apply**. The database and Key Value are created first. The api and admin deployments will fail or loop until step 3 and 4 are done: that is expected.

## 3. Connect the API to the database and Redis
1. Open **homeservices-db**. Copy the **Internal Database URL**. Add `?sslmode=require` to its end. In **homeservices-api → Environment** set `DATABASE_URL` to that.
2. Open **homeservices-redis**. Copy the **External** connection URL (it starts with `rediss://` and contains a password). Set `REDIS_URL` to it. (The internal `redis://` URL is refused by the API: production needs TLS and a password.)
3. Save. Render redeploys. In the **Logs** you should see the migrations being applied, then the API listening. Open `https://<your-api>.onrender.com/api/v1/health`: it should answer ok.

## 4. Connect the admin web
1. Copy the API's address (for example `https://homeservices-api.onrender.com`).
2. In **homeservices-admin → Environment** set `BACKEND_API_URL` to that address plus `/api/v1`.
3. In **homeservices-api → Environment** set `CORS_ORIGINS` to the admin web's address (for example `https://homeservices-admin.onrender.com`).
4. Both redeploy. The admin web will print a Next.js security-advisory notice on its first build and stop; **retry the deploy** once. Upgrading Next.js is the proper fix.

## 5. Create the data
In **homeservices-api → Shell** (a paid-plan feature):
```
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-unique-password' npm run admin:bootstrap
npm run db:seed
```
The first creates the administrator (you must change the password at first sign-in). The second creates the cities, service categories, services and the current pricing. Sign in at the admin web's address.

Then, from the admin web, approve a worker (they apply from the worker app) and book from the customer app: the pages fill up from real use. For a demo, create a few customers, workers and bookings beforehand so the screens are not empty.

## 6. Point the phone apps at the server
Build both apps in release mode with the API address, signed with your own key (see `RELEASE_BUILDS.md`):
```
flutter build apk --release --dart-define=API_BASE_URL=https://<your-api>.onrender.com/api/v1 --dart-define-from-file=maps.local.json
```
- Add the signing key's SHA-1 and SHA-256 to both Android apps in Firebase, or phone sign-in is refused.
- Allow the same key and the package names (`com.saudihomeservices.customer_app`, `com.saudihomeservices.worker_app`) in the Google Maps key restrictions.
- For sign-in without sending real SMS during the demo, add **test phone numbers** in Firebase (Authentication → Sign-in method → Phone).

## If something is wrong
- **The API will not start**: the log names the setting (never its value). Typical causes: `DATABASE_URL` without `?sslmode=require`; `REDIS_URL` that is not the external `rediss://` one; a bad `FIREBASE_SERVICE_ACCOUNT_BASE64`.
- **Admin web says it cannot reach the service**: `BACKEND_API_URL` is missing the `/api/v1`, or the API is still deploying.
- **Redis connection times out**: the Key Value's access list does not include the API (the file allows every address; it is protected by TLS and a password).
- Keep the API at **one instance**: migrations run at start and the background jobs assume a single process.
