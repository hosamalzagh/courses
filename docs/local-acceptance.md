# Local browser acceptance, 2026-09-25

Tested with Playwright against the running Herd/DBngin services, not only Laravel's HTTP test client. The local sample accounts and passwords are in ignored, mode-0600 files under `apps/api/storage/app/private/`.

1. Platform owner signed in at `courses.test/admin` with Filament MFA, saw the center list and audit screens, and provisioned alpha and beta with separate PostgreSQL databases.
2. Alpha owner accepted the emailed invitation in a browser, enrolled TOTP, signed in, created north and south branches, and invited `staff@courses.test`.
3. Staff accepted the invitation through its center host and signed in. With no grants, the dashboard showed no branches.
4. Alpha owner granted north `branch_manager` and `branch_auditor`, and south `branch_viewer`. On refresh, staff saw both branches, with edit available only for north. Authenticated requests for center settings, center members, and south audit returned 403; north audit returned 200.
5. Alpha owner removed north manager and added north viewer. The browser showed an explicit confirmation. On staff's next refresh, neither branch offered edit; a CSRF-authenticated PATCH to north returned 403.
6. Staff's beta dashboard redirected to beta login. Logging into beta with the valid central credentials was denied because no beta membership exists. The unknown center API host returned 404.
7. An alpha backup was restored; beta data and central identity remained unchanged, while alpha's post-backup branch was removed as expected. The alpha owner could still enter. Automated restoration coverage also verifies a later owner remains able to enter after an older snapshot is restored.

See `docs/query-budget.md` for the corresponding page read counts and the API query-count headers.
