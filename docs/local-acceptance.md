# Local acceptance results — 2026-09-26

The pilot uses real local Herd/Laravel, Next.js, PostgreSQL, Redis, Horizon and Mailpit services. Follow [README](../README.md) for fresh installation, bootstrap, hosts, credentials and commands. Local credentials are ignored, mode-0600 files; no production deployment was performed.

## Repeatable coverage

Run `cd apps/web && npm run test:browser` after bootstrap. The suite uses one worker, prepares missing alpha/beta invitations and sample branches, and cleans up the temporary centers/users it creates. Alpha/beta are created by the idempotent CLI bootstrap; the Landlord browser journey separately creates and retries a temporary center. This is combined bootstrap and UI evidence rather than a recording of both alpha/beta being created through the UI. Platform MFA enrollment is automated on a fresh bootstrap; center MFA is optional by default and exercised on a temporary account.

| Test | Verified behavior |
| --- | --- |
| `local-acceptance.spec.ts` (3 tests) | Alpha/beta session, page and cache isolation; Landlord suspension/reactivation with audit events and 423/200 responses; CSRF and inline validation; confirmation cancellation; Mailpit password reset and subsequent login. |
| `owner-invitation.spec.ts` | Create a center in Landlord, provision through Horizon, retry failed provisioning through Landlord, receive one owner invitation, accept/sign in, enroll/challenge/disable center MFA, invite staff, grant/change unioned branch roles, center administration and protected ownership, denial after revocation. |
| `platform-support.spec.ts` | Enroll mandatory platform MFA, access permitted support pages, redact restricted details, deny owner-only platform actions and center login. |
| `shared-identity.spec.ts` | One central user accepts alpha/beta invitations, has different branch grants and sees different data; copied host session fails; the actual Next.js page reloads remain within the SQL budget. |
| `page-query-budget.spec.ts` | All 19 ordinary authenticated pages on alpha, beta and Landlord, cold/warm totals, central/tenant split, repeated-query patterns and SQL time. |

Backend integration tests use an isolated `courses_test_central` and temporary real PostgreSQL center databases. They verify idempotent fresh bootstrap, authorization and role unions, selectors/host rejection, lifecycle and migrations, password reset/MFA, platform scoping, single-center restore, and Redis job isolation. The Redis isolation tests run alternating alpha/beta jobs including a deliberate failure on one worker PID, then run real provisioning jobs on the central platform connection. Restore tests dump/restore a dedicated test center and prove both owners can enter while beta and central identities remain intact. Application migration/grant/audit metadata is refreshed as documented in README.

## Final verification

| Gate | Result |
| --- | --- |
| `php85 artisan test --compact` | 43 passed, 845 assertions |
| `php85 vendor/bin/pint --dirty --format agent` | Passed |
| `npm run lint` | Passed |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed, optimized Next.js build |
| `npx playwright test --reporter=line` | 7 passed (2.0 minutes); expanded 19-page budget rerun passed (32.7 seconds) |
| Strict frontend project audit | Passed, zero findings |

See [query-budget.md](query-budget.md) for the measured page totals and the definition of cold/warm. No SQL-budget exception was necessary. No remaining test, lint, typecheck, build or audit failure was observed. Horizon was running after verification.

## Ticket results

The specification is #1. Execution tickets #2–#18 cover the following delivered slices; each ticket contains its own implementation and verification evidence on GitHub.

| Ticket | Result |
| --- | --- |
| #2 | Platform-owner Landlord login and measurement tools |
| #3 | Center creation and provisioning from Landlord |
| #4 | Provisioning diagnostics, retry and tenant migrations |
| #5 | First-owner invitation acceptance and central identity |
| #6 | Owner center login and permissions |
| #7 | Access recovery and session states |
| #8 | Center branch creation and management |
| #9 | Staff invitations and memberships |
| #10 | Branch assignments and branch-manager capabilities |
| #11 | Unioned branch roles and change audit |
| #12 | Center administrator and owner protection |
| #13 | Scoped platform support |
| #14 | Center suspension, domain and plan changes |
| #15 | Two-center isolation with one user identity |
| #16 | Alpha/beta Redis isolation on one worker |
| #17 | Independent single-center backup and restore |
| #18 | Fresh setup instructions, complete local acceptance and page query measurements |

Educational modules, specialized portals, file uploads/R2, custom domains and production rollout remain deferred by the pilot specification; their boundaries are in [permissions.md](permissions.md) and README.
