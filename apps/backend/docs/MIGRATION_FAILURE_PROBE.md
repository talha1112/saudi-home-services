# Migration failure probe: does a failed Prisma migration leave partial objects?

**Status: NOT RUN. The experiment is prepared and verified offline, but it was stopped before any database was created, because the isolation it requires could not be provided with the credentials available.** No result is claimed below. Nothing was created, changed or dropped in any database.

## 1. Why it was stopped

The rules require a newly created, uniquely named, disposable database. The only credentials available to this project are the application's role, which **cannot create databases** (read-only query on the maintenance database `postgres`: `rolcreatedb = false`, `rolsuper = false`). Getting around that (guessing a superuser password, altering the role, or probing inside `saudi_home_services` / `home_services_test`) is not allowed, so the run stops here and hands over the commands for manual review.

## 2. Read-only findings (verified)

| Item | Value |
|---|---|
| Prisma CLI used by the project | `prisma` 7.10.1, `@prisma/client` 7.10.1, Schema Engine `d1b3f377ca835d73fd50954a5e22128b9ebdd6b8` (`node_modules\@prisma\engines\schema-engine-windows.exe`), Node v24.15.0, Windows x64 |
| Migration command | `prisma migrate deploy` (the project script `npm run db:migrate:deploy`); the CLI accepts `--config <path>` and `--schema <path>`, so a separate configuration can be used without touching the project's |
| Project configuration | `prisma.config.ts` reads the connection string from the `DATABASE_URL` environment variable (via `dotenv/config`), migrations from `prisma/migrations` |
| PostgreSQL server | 18.6; `default_transaction_isolation = read committed`; `statement_timeout = 0`; `lock_timeout = 0` |
| Databases on the server | `home_services_test`, `postgres`, `saudi_home_services` (no probe database exists) |
| Proposed disposable name | `migration_atomicity_probe_bc4d8ab8` (random suffix; confirmed absent at the time of the check; 35 characters; not a protected name). Re-check at creation time |
| Only connection made | one read-only transaction to the maintenance database `postgres` (never to `saudi_home_services` or `home_services_test`) |

## 3. The prepared experiment (outside the project, not picked up by the real migration runner)

Kit location: `C:\Users\Acer\AppData\Local\Temp\claude\e--saudi-home-services\2aa669da-a7ea-4888-a953-efa0a4eb15c3\scratchpad\migration_probe\`

| File | Purpose |
|---|---|
| `prisma.config.ts` | Separate Prisma configuration with **no imports**. Reads `PROBE_DATABASE_URL` only, and **throws unless the database name matches `migration_atomicity_probe_<8 hex>`** (and is not one of the protected names), before Prisma can connect |
| `schema.prisma` | Datasource only, no models |
| `migrations/20300101000001_probe_baseline/migration.sql` | succeeds; proves committed objects stay visible |
| `migrations/20300101000002_probe_failing/migration.sql` | fails on purpose with a **runtime** error after several valid statements |
| `inspect.mjs` | **read-only** catalog and `_prisma_migrations` inspection (read-only transaction); refuses any non-probe database; `--require-fresh` exits non-zero if the database already has tables or a migration history |
| `run-probe.ps1` | Runs the whole sequence from the kit directory (so the project's `.env` and `prisma/migrations` are out of reach), unsets `DATABASE_URL`/`TEST_DATABASE_URL`, asks for the password with a hidden prompt, masks it in output, writes a transcript, and never drops anything |

The real migration folder `prisma/migrations` is never referenced, and the probe migrations carry timestamps (`2030...`) that cannot be mistaken for project history.

Offline verification of the kit (no database involved, a deliberately unreachable host was used): the configuration **refuses** `saudi_home_services` before any connection; with a well-formed probe name `prisma validate --config` loads it and reports the schema valid; the inspector refuses `home_services_test`; `run-probe.ps1` parses without syntax errors.

### The failing migration (verbatim)

```sql
-- Probe migration 2: fails ON PURPOSE with a RUNTIME error (not a syntax error) after several valid statements.
CREATE TYPE "ProbeEnum" AS ENUM ('A', 'B');
CREATE TABLE "probe_table" ("id" INTEGER NOT NULL, "kind" "ProbeEnum" NOT NULL DEFAULT 'A', CONSTRAINT "probe_table_pkey" PRIMARY KEY ("id"));
CREATE FUNCTION probe_noop() RETURNS trigger AS $$
BEGIN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER probe_table_noop BEFORE INSERT ON "probe_table" FOR EACH ROW EXECUTE FUNCTION probe_noop();
ALTER TABLE "probe_baseline" ADD COLUMN "probe_col" INTEGER;
CREATE TABLE "probe_dup" ("id" INTEGER NOT NULL);
CREATE TABLE "probe_dup" ("id" INTEGER NOT NULL);   -- runtime failure: the relation already exists
CREATE TABLE "probe_never" ("id" INTEGER NOT NULL);  -- must never run
```

Why a runtime error: PostgreSQL rejects a script with a *syntax* error before executing any statement, which would hide partial application. A duplicate relation fails only when that statement executes, after six statements succeeded. The statement kinds (enum, table, dollar-quoted function, trigger, `ALTER` of an existing table) mirror the real migrations.

### The sequence the runner performs

0. versions and target name; 1. precondition: database is fresh (stops otherwise); 2. `migrate deploy` (expected: migration 1 applies, migration 2 fails); 3. read-only catalog and history inspection; 4. `migrate deploy` again; 5. `migrate status`; 6. `migrate resolve --rolled-back 20300101000002_probe_failing`; 7. `migrate deploy` once more; 8. final inspection.

## 4. Commands for manual review and execution

**Step A: create the disposable database (needs a PostgreSQL superuser; the application role cannot).** Review first:

```powershell
$pg = "C:\Program Files\PostgreSQL\18\bin"
$db = "migration_atomicity_probe_bc4d8ab8"
# confirm it does not exist
& "$pg\psql.exe" --host 127.0.0.1 --port 5432 --username postgres --dbname postgres -tAc "select count(*) from pg_database where datname = '$db'"   # must print 0
# create it, owned by the application role so that role can create objects in it
& "$pg\createdb.exe" --host 127.0.0.1 --port 5432 --username postgres --owner home_services_app $db
```

**Step B: run the probe** (asks for the password of `home_services_app`; touches only the probe database):

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Acer\AppData\Local\Temp\claude\e--saudi-home-services\2aa669da-a7ea-4888-a953-efa0a4eb15c3\scratchpad\migration_probe\run-probe.ps1" -DatabaseName migration_atomicity_probe_bc4d8ab8 -Role home_services_app
```

**Step C: afterwards, drop it yourself** (this document and the runner never do):

```powershell
& "$pg\dropdb.exe" --host 127.0.0.1 --port 5432 --username postgres migration_atomicity_probe_bc4d8ab8
```

**Alternative if you prefer not to use a superuser on the project's server (needs your approval):** a private, throwaway server of the same PostgreSQL 18.6 binaries on another port, deleted afterwards. It tests the same PostgreSQL version but not the project's service configuration.

```powershell
$pg = "C:\Program Files\PostgreSQL\18\bin"; $dir = "$env:TEMP\pg_probe_cluster_bc4d8ab8"
& "$pg\initdb.exe" -D $dir -U probe_admin --auth=trust --encoding=UTF8
& "$pg\pg_ctl.exe" -D $dir -o "-p 54399 -c listen_addresses=127.0.0.1" -l "$dir\server.log" start
& "$pg\createdb.exe" --host 127.0.0.1 --port 54399 --username probe_admin migration_atomicity_probe_bc4d8ab8
# run-probe.ps1 -DatabaseName migration_atomicity_probe_bc4d8ab8 -Role probe_admin -Port 54399   (press Enter at the password prompt)
& "$pg\pg_ctl.exe" -D $dir stop            # then delete $dir
```

## 5. How to read the result (decided before running)

| Observation | Meaning |
|---|---|
| Step 2 exits non-zero with Prisma's "migration failed to apply" error naming the duplicate relation | the failure is the intended one |
| Step 3: `ProbeEnum`, `probe_table`, `probe_noop`, trigger `probe_table_noop`, `probe_dup`, column `probe_baseline.probe_col` all **absent**; `probe_baseline` present | PostgreSQL rolled back every earlier statement of the failed script: **atomic** for this setup |
| Step 3: any of those present | the script was **partly applied**: not atomic; the real migrations can leave partial objects |
| `_prisma_migrations` | expect migration 1 finished; migration 2 with `started` true, `finished` false, `rolled_back` false and the error in `logs`. Record what Prisma actually writes |
| Step 4 | expect Prisma to refuse because of the failed migration without running SQL (record the exact message/code) |
| Step 7 | if the failure is again about `probe_dup`, nothing earlier remained. If it complains that `ProbeEnum` (or another earlier object) already exists, the earlier statements had been kept |

## 6. What the result will and will not justify

Separate conclusions to fill in after the run:
1. **What PostgreSQL did with the statements:** (from step 3)
2. **What the installed Prisma runner did** (recorded in `_prisma_migrations`, exit codes, messages of steps 2, 4, 5, 7):
3. **Whether this justifies an atomicity claim for this exact setup** (Prisma 7.10.1 + schema engine `d1b3f377...` + PostgreSQL 18.6, `migrate deploy`, a script without explicit transaction control and a runtime error): yes only for that combination and that error class.
4. **Remains unproven even after a clean result:** other Prisma or PostgreSQL versions; other execution paths (`migrate dev`, `db execute`, Render's pre-deploy shell, a connection pooler in transaction mode); failures that are not a statement error (killed connection or process, `statement_timeout`/`lock_timeout`, disk full); a migration that itself contains `COMMIT` or `CONCURRENTLY` (none of the real seven does); and the exact lock behaviour of the real migrations on a large database. A stronger follow-up would terminate the backend mid-migration (`pg_terminate_backend`) in the same probe database.

Until it is run, the position in `docs/STAGING_AND_MIGRATIONS.md` stands: each real migration is probably all-or-nothing on PostgreSQL but this is **unverified**, and recovery must start by comparing the real schema with the migration file.
