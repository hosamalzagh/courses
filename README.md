# Courses — local center platform

This repository contains a Laravel landlord and center API (`apps/api`), a Next.js center UI (`apps/web`), and Mac setup scripts (`infra/mac`). A center is the contracted organization; a branch is one operating unit inside it. The system contains no educational records yet.

## Local URLs

| URL | Purpose |
| --- | --- |
| `http://courses.test/admin` | Filament landlord panel, central database only |
| `http://alpha.courses.test/admin` | Center UI for alpha |
| `http://beta.courses.test/admin` | Center UI for beta |
| `http://<center>.courses.test/api/v1/center/*` | Laravel center API on the same host |
| `http://<center>.courses.test/sanctum/csrf-cookie` | Session CSRF cookie |
| `http://127.0.0.1:8025` | Local Mailpit inbox |

Herd routes the platform host to Laravel. On a center host, Herd routes `/api` and `/sanctum` to Laravel and all UI paths to one Next.js process on loopback port 3000. Laravel resolves the center from the verified Host and keeps identities and memberships on the central connection. Each center has a separate PostgreSQL database.

## Start on a Mac

Install Laravel Herd with PHP 8.5, Composer, Node/npm, and DBngin PostgreSQL 18 plus Redis. Start Mailpit on SMTP port 1025. The local DBngin PostgreSQL tools used here are in `/Users/Shared/DBngin/postgresql/18.4_arm/bin`; change `PG_TOOLS_BIN` if your installation differs.

Create a restricted application role and two **empty** central databases in local PostgreSQL. Use a unique local password and put it only in `apps/api/.env` and `apps/api/.env.testing`:

```sql
CREATE ROLE courses_app LOGIN PASSWORD 'choose-a-local-password';
CREATE DATABASE courses_central OWNER courses_app;
CREATE DATABASE courses_test_central OWNER courses_app;
```

The provisioning connection uses the local PostgreSQL administrator only to create center databases. The daily application connection uses `courses_app`. Do not grant `CREATEDB` to the daily account.

```bash
cd apps/api
cp .env.example .env
cp .env.example .env.testing
/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85 '/Users/hosamalzagh/Library/Application Support/Herd/bin/composer' install
/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85 artisan key:generate --no-interaction
# Set DB_PASSWORD in both env files, and APP_ENV=testing plus DB_DATABASE=courses_test_central in .env.testing.
/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85 artisan key:generate --env=testing --no-interaction
/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85 artisan migrate --database=central --force --no-interaction
herd link courses --isolate=8.5 --no-interaction
cd ../web
npm ci
npm run build
cd ../..
python3 infra/mac/install-herd-routing.py
python3 infra/mac/install-web-launch-agent.py
python3 infra/mac/install-worker-launch-agent.py
cd apps/api
/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85 artisan courses:bootstrap-local --no-interaction
```

`courses:bootstrap-local` creates a platform owner and provisions alpha and beta. Add `--without-centers` to create only the first platform owner. It writes the platform owner's initial local password to `apps/api/storage/app/private/local-platform-credentials.txt` with mode `0600`; it never prints the password or replaces credentials for an existing account. The two center-owner invitations are sent to Mailpit. Accept each invitation once, then sign in with the password. Center MFA is off by default and can be enabled from **أمان الحساب** on the center dashboard. Once enabled, it applies to that central identity in every center where they are a member. Platform MFA remains required. The local bootstrap command is idempotent and is restricted to the `courses_central` database.

The LaunchAgents start the built Next.js UI, the Redis worker for provisioning, and `schedule:run` after Mac login. Rebuild `apps/web` and rerun `install-web-launch-agent.py` after UI changes. Herd remains responsible for PHP-FPM and Nginx. The routing script backs up Herd's original `courses.test` Nginx file before editing and checks Nginx syntax before restart.

## Verify and maintain

```bash
curl -I http://courses.test/admin/login
curl -I http://alpha.courses.test/login
curl -H 'Accept: application/json' -i http://alpha.courses.test/api/v1/center/user
cd apps/api
/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85 artisan test --compact
cd ../web
npm run lint
npx tsc --noEmit
npm run build
npm run test:browser
```

An unauthenticated center `user` response is `401`. Unknown or retired center hosts return `404` from the API. Suspended centers return `423` before center data is read. The tests use `courses_test_central`, temporary center databases, and Redis. Never point the test environment at `courses_central`.

The browser suite runs against the local Herd, Next.js, and Mailpit services with the accepted alpha/beta demo invitations and the ignored local credential files. It verifies the two hosts, CSRF, inline validation, a nonblocking confirmation, cache isolation, and a Mailpit password reset. The reset test updates the ignored staff credential file to the new password so the suite can run again. See `docs/local-acceptance.md` for the one-time provisioning and suspended-center browser checks.

To migrate all centers, run `php85 artisan tenants:migrate --force --no-interaction`; to migrate one, add `--tenants=<center UUID>`. The worker uses queue `platform` for provisioning. Telescope is available only locally at `/telescope` to platform owners; authentication, invitation, MFA, and credential-producing jobs are excluded from recording, and mail, event, and Redis watchers are disabled to avoid retaining secrets. It still records ordinary page reads and their queries. The scheduler prunes entries older than 48 hours.

In the maintenance commands below, `php85` denotes `/Users/hosamalzagh/Library/'Application Support'/Herd/bin/php85`.

Back up and restore one local center with:

```bash
php85 artisan courses:backup alpha
php85 artisan courses:restore alpha storage/app/private/backups/alpha-<uuid>-<timestamp>.dump --confirm=alpha
php85 artisan courses:reconcile-grants alpha --apply
```

Restore accepts only a backup file whose name contains that center's exact UUID. It restores that center's database, then removes grants without active central membership and repairs the first accepted owner's role if necessary. The central database and other center databases are untouched. These commands are restricted to local/testing environments.

See [permission matrix](docs/permissions.md) and [query measurements](docs/query-budget.md). The domain vocabulary and data boundaries are in [CONTEXT.md](CONTEXT.md) and `docs/adr/`.
