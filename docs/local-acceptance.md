# Local browser acceptance, 2026-09-25

Tested with Playwright against the running Herd/DBngin services, not only Laravel's HTTP test client. The local sample accounts and passwords are in ignored, mode-0600 files under `apps/api/storage/app/private/`.

1. Platform owner signed in at `courses.test/admin` with Filament MFA, saw the center list and audit screens, and provisioned alpha and beta with separate PostgreSQL databases.
2. Alpha owner accepted the emailed invitation in a browser, signed in, created north and south branches, and invited `staff@courses.test`. MFA was mandatory when this initial acceptance run was recorded; it is now optional for center accounts and controlled from **أمان الحساب**.
3. Staff accepted the invitation through its center host and signed in. With no grants, the dashboard showed no branches.
4. Alpha owner granted north `branch_manager` and `branch_auditor`, and south `branch_viewer`. On refresh, staff saw both branches, with edit available only for north. Authenticated requests for center settings, center members, and south audit returned 403; north audit returned 200.
5. Alpha owner removed north manager and added north viewer. The browser showed an explicit confirmation. On staff's next refresh, neither branch offered edit; a CSRF-authenticated PATCH to north returned 403.
6. Staff's beta dashboard redirected to beta login. Logging into beta with the valid central credentials was denied because no beta membership exists. The unknown center API host returned 404.
7. An alpha backup was restored; beta data and central identity remained unchanged, while alpha's post-backup branch was removed as expected. The alpha owner could still enter. Automated restoration coverage also verifies a later owner remains able to enter after an older snapshot is restored.
8. Staff requested a password reset from `alpha.courses.test/forgot-password`, received the link in Mailpit, set a new password in the browser, and signed in with it. A browser PATCH to center settings without a CSRF token returned 419.
9. A temporary platform-support account signed in to Landlord after enrolling in mandatory MFA. Its attempt to sign in to alpha showed the center permission error. The account was removed after the check.
10. Beta's owner accepted the one-use Mailpit invitation and signed in. Beta showed only `beta-stable`; alpha showed only its north and south branches. Navigating the same browser between hosts sent it to the other center's login page. Returning to its own host restored only its own data, including after reloads.
11. With beta temporarily suspended in the local central database, its authenticated browser page showed **المركز غير متاح الآن**. Beta was immediately reactivated, and a reload restored its branch view.

See `docs/query-budget.md` for the corresponding page read counts and the API query-count headers.

## Optional center MFA follow-up

After changing center MFA to opt-in, a fresh browser session signed in as the alpha owner with email/password alone and reached `/admin`. The **أمان الحساب** link opened `/admin/security`, which reported MFA off. Starting enrollment displayed a QR code; cancelling it returned to the off state. The authenticated `user` response still used five SQL queries. The backend feature test covers enabling MFA, the next login challenge, one-use recovery codes, disabling MFA, and refusal to disable MFA for an account with a platform role.

The temporary platform-support browser run also confirmed that MFA remains required for Landlord accounts. A later browser read of Landlord's center list, user list, and audit list and each Next.js center page was measured at first load after clearing Laravel's application cache and again on reload. Telescope recorded one Laravel data request per center page; the counts are in `docs/query-budget.md`.
