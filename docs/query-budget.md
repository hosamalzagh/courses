# Local query budget

Measured on 2026-09-26 with authenticated Playwright browsers against Herd, Next.js, PostgreSQL and Redis. Alpha had two branches and two active members; beta had one branch and its owner. Landlord used the platform owner after MFA.

`tests/page-query-budget.spec.ts` captures a Telescope sequence before each full page navigation, finds every Laravel request for that host after the boundary, and sums the query-count and SQL-time headers. Query entries in those request batches supply central/center totals and duplicate patterns (connection plus raw-query hash). The recorded query count must match the headers and the entire page must stay at or below six. This includes Next.js server fetches that are absent from the browser network panel.

Cold means Laravel's application cache was cleared immediately before navigation; it does not mean PostgreSQL or the operating-system cache was restarted. Warm is the next navigation to the same URL. Every measured page produced one Laravel data request on both loads. Redis session/cache operations and Telescope's own storage are outside the application SQL count. No exception to the six-query budget was needed.

All paired values below are **cold / warm**. SQL time is milliseconds for the complete page's Laravel requests.

| Authenticated page | Data requests | Cold central / center | Warm central / center | Total SQL | Duplicate patterns | SQL ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `alpha.courses.test/admin` | 1 / 1 | 3 / 2 | 3 / 2 | 5 / 5 | 0 / 0 | 28.75 / 30.26 |
| `alpha.courses.test/admin/settings` | 1 / 1 | 3 / 3 | 3 / 3 | 6 / 6 | 0 / 0 | 31.44 / 31.74 |
| `alpha.courses.test/admin/members` | 1 / 1 | 4 / 2 | 4 / 2 | 6 / 6 | 0 / 0 | 34.66 / 32.66 |
| `alpha.courses.test/admin/audit` | 1 / 1 | 3 / 3 | 3 / 3 | 6 / 6 | 0 / 0 | 31.83 / 33.64 |
| `alpha.courses.test/admin/security` | 1 / 1 | 3 / 2 | 3 / 2 | 5 / 5 | 0 / 0 | 31.58 / 28.15 |
| `beta.courses.test/admin` | 1 / 1 | 3 / 2 | 3 / 2 | 5 / 5 | 0 / 0 | 31.61 / 21.75 |
| `beta.courses.test/admin/settings` | 1 / 1 | 3 / 3 | 3 / 3 | 6 / 6 | 0 / 0 | 29.08 / 32.74 |
| `beta.courses.test/admin/members` | 1 / 1 | 4 / 2 | 4 / 2 | 6 / 6 | 0 / 0 | 31.05 / 29.07 |
| `beta.courses.test/admin/audit` | 1 / 1 | 3 / 3 | 3 / 3 | 6 / 6 | 0 / 0 | 28.80 / 32.61 |
| `beta.courses.test/admin/security` | 1 / 1 | 3 / 2 | 3 / 2 | 5 / 5 | 0 / 0 | 30.75 / 29.93 |
| `courses.test/admin` | 1 / 1 | 1 / 0 | 1 / 0 | 1 / 1 | 0 / 0 | 13.70 / 14.46 |
| `courses.test/admin/centers` | 1 / 1 | 4 / 0 | 4 / 0 | 4 / 4 | 0 / 0 | 19.58 / 17.95 |
| `courses.test/admin/centers/create` | 1 / 1 | 1 / 0 | 1 / 0 | 1 / 1 | 0 / 0 | 11.69 / 13.56 |
| `courses.test/admin/users/create` | 1 / 1 | 1 / 0 | 1 / 0 | 1 / 1 | 0 / 0 | 13.30 / 8.27 |
| `courses.test/admin/users/{user}/edit` | 1 / 1 | 2 / 0 | 2 / 0 | 2 / 2 | 0 / 0 | 14.45 / 14.96 |
| `courses.test/admin/users` | 1 / 1 | 3 / 0 | 3 / 0 | 3 / 3 | 0 / 0 | 17.67 / 16.69 |
| `courses.test/admin/platform-audit-logs` | 1 / 1 | 3 / 0 | 3 / 0 | 3 / 3 | 0 / 0 | 15.90 / 16.64 |
| `courses.test/admin/centers/{center}` | 1 / 1 | 3 / 0 | 3 / 0 | 3 / 3 | 0 / 0 | 18.08 / 17.47 |
| `courses.test/admin/centers/{center}/edit` | 1 / 1 | 3 / 0 | 3 / 0 | 3 / 3 | 0 / 0 | 14.25 / 8.77 |

The run's machine-readable output is the ignored `apps/web/test-results/page-query-budget.json`; rerun `cd apps/web && npx playwright test tests/page-query-budget.spec.ts` to refresh it. This table records the completed 19-page run at 2026-09-26T02:37:21.959Z. SQL timings vary with local load; query counts are the acceptance gate.

`MeasureCenterQueries` exposes `X-Courses-Query-Count` and `X-Courses-Sql-Ms` for local/test HTTP reads. Reads above six log connection totals and repeated-query patterns without bindings. Telescope excludes credential-producing requests/jobs, while ordinary page reads remain available for measurement.

PostgreSQL integration tests also cover failed/suspended center status and the member-workspace reads with multiple branches/members. Center grants use one union query; the member page uses one central union for members/invitations and one center union for branches/grants. Writes, provisioning, backup and restore have separate workloads. Recheck the page gate when adding data or Filament resources.
