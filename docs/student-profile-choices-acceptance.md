# Student profile lists — #57

Center owners and administrators manage city, qualification, profession, collection method and discovery source at `/admin/student-profile-choices`. Registration staff select these in the dedicated student create/edit form. School, employer and specialization remain free text. Entering a source never changes the recorded employee or creation time.

Definitions and student foreign keys live only in each center database. The migration extends both newly provisioned and existing centers without rewriting existing student identifiers, numbering, requests, branches or audit history. Disabling a definition blocks new uses, preserves existing selections during unrelated edits, and keeps its label visible. Renaming changes the current label; audit records retain the before/after labels. Category changes and deletion are unavailable.

Definition creation uses a stable UUID and payload hash so retries after a lost response return the same definition. Updates use revisions and expose recoverable conflicts. Center locks serialize definition writes with student writes; current membership, center state and permissions are checked again inside the write. Definition, student and associated audit writes are atomic on the tenant connection. The central lock is coordination, not a distributed transaction guarantee.

The management page searches/paginates in SQL with 50 definitions per response. Form choices load 50 per category with progressive paging/search; the saved choice remains visible outside the first page and while searching. Both readers use shared shadcn components, shared header actions and native unique form ownership. Page content and data remain server rendered; navigation preserves the center shell.

## Verification on 2026-09-27

- Full Laravel suite: 103 passed, 2456 assertions after building the local Vite assets.
- Focused HTTP tests: 35 passed, 965 assertions (choice management, old disabled values, revisions/retries, current role checks, two centers sharing a login, existing-center migration, student profile/numbering/sharing/suspension regressions).
- Real browser: seven dedicated journeys through production-built Next.js, Laravel and disposable PostgreSQL, with real login/session and CSRF. Covers all lists, registration/manager separation, direct cross-center rejection, revoked authority, concurrent requests, long lists, clearing filtered choices, server pagination after reordering, stale revision recovery, lost response retry and readable audit.
- Three existing browser integration journeys pass: cached editors with unique submit ownership; numbering/sharing/suspension and general edits; full SSR read budget including profile/edit and warm navigation.
- Actual SSR measurements from the proxy: management 5; student register/create/profile/edit each 6. Warm intent navigation stays within 6, sends no document request, and retains the same header element. Missing SQL counts fail acceptance.
- Desktop/mobile RTL and light/dark screenshots were visually inspected. Header actions, validation focus, cancel focus and table overflow were exercised. Lint, TypeScript and production build pass.

## Repeating the browser acceptance

Use a disposable PostgreSQL cluster on port 5557 with a fresh `courses_central` database. The fixture intentionally accepts only this isolated local configuration. From `apps/api`, apply central migrations, then run:

```sh
COURSES_CHOICES_ISOLATED=1 DB_HOST=127.0.0.1 DB_PORT=5557 DB_USERNAME=postgres DB_DATABASE=courses_central TELESCOPE_ENABLED=false SESSION_DRIVER=file CACHE_STORE=array QUEUE_CONNECTION=sync PLATFORM_QUEUE_DRIVER=sync php85 artisan tinker --execute="require base_path('tests/Fixtures/StudentProfileChoicesBrowserFixture.php');"
```

Run Laravel on 8157 with those environment values, Next.js on 3057 with `COURSES_INTERNAL_API_ORIGIN=http://{host}:8057`, and an HTTP proxy on 8057 that forwards `/api/` and `/sanctum/` to Laravel and other routes to Next.js, preserving Host/cookies. For each GET `/api/v1/center/` response, append `{path,host,count}` to a JSONL file, taking numeric `count` from `X-Courses-Query-Count` and keeping a missing count as null. Include SSR requests through that same proxy. Alpha/beta hosts must resolve to loopback.

From `apps/web`, pass `COURSES_CHOICES_CREDENTIALS` as the absolute fixture credentials path `apps/api/storage/app/private/student-choices-browser-credentials.json` and `COURSES_CHOICES_READ_LOG` as the proxy's JSONL path, then run `npx playwright test student-profile-choices.spec.ts`. Credentials are mode 0600 and never committed. Without this disposable fixture the dedicated suite is skipped, keeping ordinary local suites independent.

#58 owns the subsequent contact expansion; #61 owns identity data and access. Later custom-field journeys must integrate with these lists and preserve their selections. No portal, identity field, contact channel or production deployment is included in #57.
