# Phase 3 local acceptance (#54)

This is a repeatable, **local-only** acceptance run against disposable PostgreSQL. It uses the real Laravel API, a production-built Next.js server, browser login/session/CSRF, and two independently provisioned centers. It does not claim production deployment.

## Isolated setup

Use an empty PostgreSQL cluster on `127.0.0.1:5554` with database `courses_issue54_central` and user `postgres`. The fixture refuses a non-local app, any other host/port/database, or a run without `COURSES_PHASE3_ISOLATED=1`. The following commands assume a local PostgreSQL installation and run from the repository root:

```sh
initdb -D /tmp/courses-issue54-pg -U postgres -A trust
pg_ctl -D /tmp/courses-issue54-pg -o '-h 127.0.0.1 -p 5554' -l /tmp/courses-issue54-postgres.log start
createdb -h 127.0.0.1 -p 5554 -U postgres courses_issue54_central
cd apps/api
DB_HOST=127.0.0.1 DB_PORT=5554 DB_DATABASE=courses_issue54_central DB_USERNAME=postgres DB_PASSWORD= PROVISION_DB_USERNAME=postgres PROVISION_DB_PASSWORD= TELESCOPE_ENABLED=false SESSION_DRIVER=file CACHE_STORE=array QUEUE_CONNECTION=sync PLATFORM_QUEUE_DRIVER=sync php85 artisan migrate --database=central --force --no-interaction
COURSES_PHASE3_ISOLATED=1 DB_HOST=127.0.0.1 DB_PORT=5554 DB_DATABASE=courses_issue54_central DB_USERNAME=postgres DB_PASSWORD= PROVISION_DB_USERNAME=postgres PROVISION_DB_PASSWORD= TELESCOPE_ENABLED=false SESSION_DRIVER=file CACHE_STORE=array QUEUE_CONNECTION=sync PLATFORM_QUEUE_DRIVER=sync php85 artisan tinker --execute="require base_path('tests/Fixtures/Phase3LocalAcceptanceFixture.php');"
DB_HOST=127.0.0.1 DB_PORT=5554 DB_DATABASE=courses_issue54_central DB_USERNAME=postgres DB_PASSWORD= PROVISION_DB_USERNAME=postgres PROVISION_DB_PASSWORD= TELESCOPE_ENABLED=false SESSION_DRIVER=file CACHE_STORE=array QUEUE_CONNECTION=sync PLATFORM_QUEUE_DRIVER=sync php85 artisan courses:migrate-centers --no-interaction
```

The fixture creates `alpha.courses.test` and `beta.courses.test`; alpha has north/south branches, an owner, and a north registration employee. It writes synthetic credentials to the ignored mode-0600 `apps/api/storage/app/private/phase3-local-acceptance-credentials.json`. Never copy this file into the repository. Both names must resolve to loopback on the test machine. A second fixture run requires a fresh empty cluster.

Start three Laravel worker processes on 8154–8156 with the same database variables. From `apps/api/public`, use `php85 -S 127.0.0.1:8154 -t . ../vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php` for the first and substitute 8155/8156 for the others. Start the production Next.js server from `apps/web` with `npm run build`, then `COURSES_INTERNAL_API_ORIGIN='http://{host}:8054' PORT=3054 npm run start`. Start `COURSES_PHASE3_QUERY_LOG=/tmp/courses-issue54-queries.jsonl node tests/fixtures/phase3-proxy.cjs` in `apps/web`. The proxy on 8054 preserves Host and cookies, forwards API/CSRF to Laravel and pages to Next.js, and records every center GET SQL count, including server-side Next.js reads. Missing counts remain `null` and fail the test.

From `apps/web`:

```sh
COURSES_PHASE3_ORIGIN=http://alpha.courses.test:8054 \
COURSES_PHASE3_CREDENTIALS=../api/storage/app/private/phase3-local-acceptance-credentials.json \
COURSES_PHASE3_QUERY_LOG=/tmp/courses-issue54-queries.jsonl \
npx playwright test tests/phase3-local-acceptance.spec.ts --workers=1
```

The browser suite writes its machine-readable counts to ignored `apps/web/test-results/phase3-local-acceptance.json`. Related suites use their own `COURSES_*_ORIGIN`, `COURSES_*_CREDENTIALS`, `COURSES_*_QUERY_LOG`, and sometimes `COURSES_*_DB_PORT=5554` settings; concurrent HTTP suites use worker ports 8155 and 8156. Do not point them at another running local center.

At 2026-09-29 03:20 UTC, the integrated browser suite passed 2/2 on the isolated cluster. Its 23 recorded reads included ten full page visits and thirteen direct API reads; every one measured exactly six SQL statements. The full page visits covered account, enrollment, study tab, attendance, coverage, the narrow mobile enrollment view, and the student register before and after 55 additional students, including page two. Earlier fresh-center and repeated populated-center runs had the same budget. The related browser suites passed 41 additional tests before the #43/#44 integration. Laravel feature tests passed 46/46 across migration, coverage, finance, search, curriculum, suspension and actual Redis worker isolation (including a failed job between centers). TypeScript, focused ESLint and Pint checks passed.

## Acceptance matrix

| Area | Durable/HTTP/UI/browser evidence |
| --- | --- |
| Identity, branches, people, curriculum, groups | `phase3-local-acceptance.spec.ts`, `study-groups.spec.ts`, `curriculum-copy.spec.ts`, and `CenterStudentSearchTest.php`; alpha owner and restricted employee, beta owner, two alpha branches. |
| Enrollment, waitlist, transfer | `phase3-local-acceptance.spec.ts`, `study-enrollment.spec.ts`, `study-bulk-waitlist.spec.ts`, `study-transfers.spec.ts`; same attempt/fee survives waitlist and reattachment. |
| Teaching, attendance, absence, makeup, course completion | `study-teaching.spec.ts`, `study-attendance.spec.ts`, `study-attendance-corrections.spec.ts`, `study-absence-review.spec.ts`, `study-makeup.spec.ts`, `study-suspension-completion.spec.ts`; missing content remains visible until a valid counted makeup. |
| Required lectures and plan versions | `study-coverage.spec.ts`, `study-threshold-application.spec.ts`, plus the integrated #43/#44 journey in this ticket after their merge. |
| Money and corrections | `student-finance.spec.ts`, `student-fee-adjustment.spec.ts`; receipt remains while allocations are corrected; settlement/refund/corrections reconcile with no invented receipt. |
| Tenant and scope isolation | Alpha/beta direct-ID denial and north-only staff denials in `phase3-local-acceptance.spec.ts`; the domain suites exercise current authorization, stale revisions, idempotency and request races. |
| Read budget | Every measured ordinary page GET across the proxy includes Next.js SSR and Laravel central/tenant SQL; a missing/nonnumeric count fails, and total must be `<=6`. The short journey and 55-extra-student pagination journey measure cold and warm visits. |

The local test journey also exercises Arabic RTL at 390 px, light/dark switching, mobile overflow, validation focus, error/denied states and audit visibility. The domain browser suites cover wider screen actions, loading and stale-preview recovery. Test data is synthetic. The acceptance is complete only when the integrated #43/#44 interaction and final migration/worker checks have passed on the same branch.
