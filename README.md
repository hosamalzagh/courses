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

Install Laravel Herd with PHP 8.5, Composer, Node.js 20.9 or newer/npm, and DBngin PostgreSQL 18 plus Redis. Enable Herd's command-line tools in your shell so `php85` and `herd` resolve. Start Mailpit on SMTP port 1025 and its inbox on port 8025. The local DBngin PostgreSQL tools used here are in `/Users/Shared/DBngin/postgresql/18.4_arm/bin`; change `PG_TOOLS_BIN` if your installation differs.

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
php85 "$HOME/Library/Application Support/Herd/bin/composer" install
php85 artisan key:generate --no-interaction
# Set DB_PASSWORD, PROVISION_DB_* and PG_TOOLS_BIN in both env files.
# Set APP_ENV=testing and DB_DATABASE=courses_test_central in .env.testing.
php85 artisan key:generate --env=testing --no-interaction
php85 artisan migrate --database=central --force --no-interaction
herd link courses --isolate=8.5 --no-interaction
cd ../web
npm ci
npx playwright install chromium
npm run build
cd ../..
python3 infra/mac/install-herd-routing.py
python3 infra/mac/install-web-launch-agent.py
python3 infra/mac/install-worker-launch-agent.py
cd apps/api
php85 artisan courses:bootstrap-local --no-interaction
```

`courses:bootstrap-local` creates a platform owner and provisions alpha and beta. Add `--without-centers` to create only the first platform owner. It writes the platform owner's initial local password to `apps/api/storage/app/private/local-platform-credentials.txt` with mode `0600`; it never prints the password or replaces credentials for an existing account. The two center-owner invitations are sent to Mailpit. Accept each invitation once, then sign in with the password. Center MFA is off by default and can be enabled from **أمان الحساب** on the center dashboard. Once enabled, it applies to that central identity in every center where they are a member. Platform MFA remains required. The local bootstrap command is idempotent and is restricted to the `courses_central` database.

On the platform owner's first sign-in, complete **Set up** with an authenticator app, the current password and its six-digit code, then save the recovery codes and continue. The browser suite performs this enrollment for a fresh platform account. To create further centers from Landlord, open **المراكز → Create**, enter the unique slug/subdomain, plan and first-owner email, then wait for **active**; Horizon sends the one-use Mailpit invitation.

The LaunchAgents start the built Next.js UI, Horizon with separate Redis supervisors for platform provisioning and default jobs, and `schedule:run` after Mac login. Rebuild `apps/web` and rerun `install-web-launch-agent.py` after UI changes. Herd remains responsible for PHP-FPM and Nginx. The routing script backs up Herd's original `courses.test` Nginx file before editing and checks Nginx syntax before restart.

Without the worker LaunchAgent, run `cd apps/api && php85 artisan horizon` in a terminal. Horizon's `platform:platform` supervisor handles center provisioning; `redis:default` handles tenant-aware jobs. Platform queue payloads stay central even when dispatched during a center context. To verify that one Redis worker handles alpha, a failing alpha job, beta, and alpha again without carrying over tenant database, cache, or audit state, run `php85 artisan test --compact tests/Feature/WorkerIsolationTest.php` from `apps/api`. The test starts temporary workers on unique queues, checks their process IDs, and runs both owner invitations after a deliberate failure through one platform worker. It uses `courses_test_central` and temporary center databases.

After pulling code changes into an existing local installation, run `php85 artisan migrate --database=central --force` and `php85 artisan courses:migrate-centers` before testing center writes. The scheduler retries center audit entries that could not be delivered during a temporary center database outage; `php85 artisan courses:deliver-center-audit` runs the same retry on demand.

## Verify and maintain

```bash
curl -I http://courses.test/admin/login
curl -I http://alpha.courses.test/login
curl -H 'Accept: application/json' -i http://alpha.courses.test/api/v1/center/user
cd apps/api
php85 artisan test --compact
cd ../web
npm run lint
npx tsc --noEmit
npm run build
npm run test:browser
```

An unauthenticated center `user` response is `401`. Unknown or retired center hosts return `404` from the API. Suspended centers return `423` before center data is read. The tests use `courses_test_central`, temporary center databases, and Redis. Never point the test environment at `courses_central`.

The browser suite runs against the local Herd, Next.js, and Mailpit services after `courses:bootstrap-local`. On a fresh install it accepts the alpha/beta invitations from Mailpit, creates sample branches, invites a staff account, and stores passwords only in ignored mode-0600 local credential files. It then verifies host and cache isolation, CSRF, inline validation, a nonblocking confirmation, and a Mailpit password reset. Additional journeys create and retry a center through Landlord and Horizon, accept its owner invitation, exercise MFA and role changes, enroll a support account and prove its restrictions, suspend/reactivate a center through Landlord, and give one identity different grants in alpha and beta. The page-budget journey measures all 19 ordinary pages after clearing the application cache and again on reload. The reset test updates the ignored staff credential file to the new password so the suite can run again. If you reset the local databases, remove the three ignored `local-{alpha,beta,staff}-credentials.txt` files before running bootstrap and the browser suite again. If a sample invitation was already used but its credential file was removed, restore that password or reset the local sample databases. For a sample account with MFA enabled, disable it from **أمان الحساب** using its authenticator before running the automated suite. See `docs/local-acceptance.md` for the automated coverage and final verification results.

To migrate all existing center databases independently, run `php85 artisan courses:migrate-centers --no-interaction`; to migrate one, run `php85 artisan courses:migrate-centers --center=alpha --no-interaction` using its slug. The command reports success or failure for each center and returns a nonzero exit code if any failed, while continuing to the other centers. A missing database is marked `not_created`; a migration failure leaves the last applied migration version visible. Check the center's Landlord status and server log, then use **إعادة التجهيز** after fixing the cause. That action resumes creation/migrations and does not create another center or invitation. The command updates migrations only and does not activate a failed center; use the retry action to complete provisioning. Horizon consumes provisioning jobs from the Redis `platform` queue. Telescope is available only locally at `/telescope` to platform owners; authentication, invitation, MFA, and credential-producing jobs are excluded from recording, and mail, event, and Redis watchers are disabled to avoid retaining secrets. It still records ordinary page reads and their queries. The scheduler prunes entries older than 48 hours.

The commands use Herd's PHP 8.5 CLI (`php85`).

For an isolated backup/restore acceptance run, use `php85 artisan test --compact tests/Feature/CenterRestoreTest.php` from `apps/api`. The test requires `courses_test_central`, creates two temporary center databases, restores only its alpha snapshot, checks real owner logins and beta isolation, and removes the temporary dump and databases. It does not restore the development alpha or beta databases.

To back up and restore an operator-selected local center, use:

```bash
php85 artisan courses:backup alpha
php85 artisan courses:restore alpha storage/app/private/backups/alpha-<uuid>-<timestamp>.dump --confirm=alpha
php85 artisan courses:reconcile-grants alpha --apply
php85 artisan courses:reconcile-grants alpha --apply --invalidate-versions # after a rare central commit failure
```

Restore accepts only a backup file whose name contains that center's exact UUID. It restores that center's database, reapplies current center migrations, removes grants without active central membership, retains current active owners and repairs the first accepted owner's role if necessary, and replays centrally recorded audit entries missing from the snapshot. Central user identities and membership statuses remain unchanged; only the restored center's migration metadata and grant versions are refreshed. Other center databases and metadata remain unchanged. These commands are restricted to local/testing environments.

See [permission matrix](docs/permissions.md) and [query measurements](docs/query-budget.md). The domain vocabulary and data boundaries are in [CONTEXT.md](CONTEXT.md) and `docs/adr/`.

## Production routing design

This is a routing design for a future deployment. A managed base domain and its wildcard TLS certificate reach one trusted ingress. The platform host sends Landlord and platform API paths to Laravel; each accepted center subdomain sends `/api/v1/center/*` and `/sanctum/*` to Laravel and all center UI paths to the same Next.js service. The ingress preserves the original host, and Laravel resolves only domains registered centrally. Sessions remain host-only with secure cookies. PostgreSQL and Redis stay on private networks, with separate platform and tenant queue supervisors.

Before deploying, replace the local domain allowlists in Laravel's bootstrap and Next.js server context, configure HTTPS/session settings and trusted ingress proxies, and supply production database/mail credentials outside Git. Custom center domains, production deployment and the database hosting choice are deferred.
