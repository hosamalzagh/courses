# Local query budget

`MeasureCenterQueries` counts Laravel SQL queries by connection and SQL time for local/test HTTP reads. Responses include `X-Courses-Query-Count` and `X-Courses-Sql-Ms`; reads above six log connection totals and repeated-query patterns without SQL bindings. Telescope stores ordinary HTTP read and query details on the central connection; credential-producing requests and jobs are excluded. Redis session/cache operations are outside the SQL count.

Authenticated browser measurements on 2026-09-25 used local alpha (two branches and two active members), beta (one branch and one owner), and Landlord. Before each first navigation, `artisan cache:clear` cleared Laravel's application cache. The warm measurement was a browser reload. Telescope request entries between the navigation boundaries confirmed exactly one Laravel data request per Next.js page; the table sums every Laravel request observed for that page. Next.js uses `cache: "no-store"` for those requests. Telescope's own storage queries are excluded.

| Authenticated page | Cold SQL | Warm SQL | Cold central / center | Warm central / center | Warm SQL ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Alpha `/admin` | 5 | 5 | 3 / 2 | 3 / 2 | 24.90 |
| Alpha `/admin/settings` | 6 | 6 | 3 / 3 | 3 / 3 | 26.84 |
| Alpha `/admin/members` | 6 | 6 | 4 / 2 | 4 / 2 | 25.18 |
| Alpha `/admin/audit` | 6 | 6 | 3 / 3 | 3 / 3 | 22.81 |
| Alpha `/admin/security` | 5 | 5 | 3 / 2 | 3 / 2 | 22.27 |
| Beta `/admin/members` | 6 | 6 | 4 / 2 | 4 / 2 | 31.19 |
| Landlord `/admin` | 1 | 1 | 1 / 0 | 1 / 0 | 9.21 |
| Landlord `/admin/centers` | 4 | 4 | 4 / 0 | 4 / 0 | 13.35 |
| Landlord `/admin/users` | 3 | 3 | 3 / 0 | 3 / 0 | 11.34 |
| Landlord `/admin/platform-audit-logs` | 2 | 2 | 2 / 0 | 2 / 0 | 11.31 |

The platform-owner login integration test completes Filament's MFA challenge, starts a fresh authenticated request, and checks the budget for the Landlord dashboard, center list, platform-user list, and audit list. The query meter runs before Filament's authenticated-session middleware so the user lookup is included. Telescope recorded no repeated SQL patterns in the measured warm requests.

For a failed center status page, a PostgreSQL-backed integration run on 2026-09-26 measured `GET /admin/centers/{id}` at 3 central / 0 center SQL queries on the first request and 3 / 0 on a repeat request. SQL time was 1.26 ms and 0.84 ms respectively. The test asserts both reads stay at or below six while the page displays the operational failure; these figures are test-client measurements, separate from the browser measurements above.

The member-workspace integration test also asserts at most six queries for the API data reads used by `/admin`, `/admin/settings`, `/admin/audit`, `/admin/security` (the same `user` read), and `/admin/members` with two branches and two members, guarding against N+1 growth. Center grants are loaded with one union query. The member page uses one central union for members/invitations and one center union for branches/grants. The Next.js server fetches are absent from the browser network panel but present as request entries in Telescope; their `X-Courses-Query-Count` and `X-Courses-Sql-Ms` response headers and query entries supplied these counts. These are read-page measurements; writes, provisioning, backup, and restore have separate workloads. Recheck the counts after adding page data or Filament resources.
