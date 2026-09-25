# Local query budget

`MeasureCenterQueries` counts Laravel SQL queries by connection and SQL time for local/test HTTP reads. Responses include `X-Courses-Query-Count` and `X-Courses-Sql-Ms`; reads above six log connection totals and repeated-query patterns without SQL bindings. Telescope records request and query details on the central connection. Redis session/cache operations are outside the SQL count.

Authenticated browser measurements on 2026-09-25 with local alpha (two branches and two active members). Each Next.js page performs one server-side API fetch on its initial render; the table is the SQL count for that entire page data fetch, not a sum of unrelated endpoints. Two successive no-store reads per route gave the same count:

| Initial page data | First read | Second read |
| --- | ---: | ---: |
| Center `/admin` via `user` | 5 | 5 |
| Center `/admin/settings` via `user?include=settings` | 6 | 6 |
| Center `/admin/audit` via `user?include=audit` | 6 | 6 |
| Center `/admin/members` via `member-workspace` | 6 | 6 |
| Landlord center list | 3 |
| Landlord platform-user list | 2 |
| Landlord platform audit list | 1 |

The member-workspace integration test also asserts at most six queries with two branches and two members, guarding against N+1 growth. Center grants are loaded with one union query. The member page uses one central union for members/invitations and one center union for branches/grants. The Next.js server fetches are not visible as browser network requests, so counts were read from the corresponding authenticated API responses and the one-fetch page source. These are read-page measurements; writes, provisioning, backup, and restore have separate workloads. Recheck the counts after adding page data or Filament resources.
