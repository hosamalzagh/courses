# UX Contract

## Product context

- Audience: Center owners, center administrators, and branch staff.
- Primary jobs: Sign in, accept invitations, optionally enable TOTP from account security, see active membership, and manage authorized branches, staff, settings, and audit.
- Active locale: Arabic, RTL; email and domain strings remain left to right. Timezone: Africa/Cairo for local operations.
- Accessibility target: WCAG 2.2 AA.

## Business-context sources

| Scope | Source | Reviewed |
|---|---|---|
| Center and branch vocabulary | `CONTEXT.md` | 2026-09-25 |
| Database and role boundaries | `docs/adr/0001-center-data-and-identity-boundaries.md` | 2026-09-25 |
| Initial workflow and exclusions | GitHub issue #1 | 2026-09-25 |

## Visual contract

`DESIGN.md` records visual decisions. `apps/web/app/globals.css` owns runtime tokens. Filament's panel is a separate implementation of the same product register.

## Canonical UI Map

| Capability | Owner | Contract | Verification |
|---|---|---|---|
| Form | `apps/web/components/FormField.tsx` | Persistent label, hint, and accessible error slot | Browser login and invitation flow |
| Scrollbar | `apps/web/app/globals.css` | Global visible scrollbar; stable width | Computed style check |
| Feedback | `apps/web/components/InlineNotice.tsx` | Text status in a live region | Browser failure and success paths |
| CRUD | Laravel HTTP API plus `apps/web/app/admin` | Save keeps the user in the branch list; server result refreshes the page | Browser create and edit flow |
| Staff grants | `apps/web/app/admin/members` | Center roles and per-branch roles remain separate | Real PostgreSQL integration test |
| Settings and audit | `apps/web/app/admin/settings` and `audit` | Server-provided initial data, no shared private cache | Authenticated browser and query meter |

Table selection, date controls, and authored select boxes are absent from the first center screens.

## Flow ledger

| Operation | Pending | Success | Failure |
|---|---|---|---|
| Accept invitation | Disable action, keep form | Go to login | Keep fields, show actionable error |
| Sign in | Disable action, keep email | TOTP step or center home | Clear password, keep email |
| TOTP | Disable action, keep code field | Center home | Clear code and allow retry |
| Create/edit branch | Disable save, retain entered data | Refresh branch list with status | Retain fields and show inline error |
| Sign out | Disable action | Go to login | Keep page and show retry message |
| Invite/edit member | Disable action, keep selection | Refresh member list, show status | Keep selections and explain API denial |
| Save settings | Disable action, keep values | Show saved notice | Keep values and show retry message |
| Reset password | Disable action | Show success with login link | Keep email and show error |

## Permission and session behavior

- The API is the authority. The interface uses `/api/v1/center/user` only for current-center display decisions and never grants access locally.
- A forbidden branch action shows an explicit inline 403 message; a direct route to a forbidden page shows a clear state.
- A 401 response during protected client actions sends the user to login. A suspended center shows a distinct unavailable state. A center page is fetched with `no-store`.
- Role changes are reflected by the next protected request. The UI refreshes after each mutation.
- Cookies stay host-only; the browser never sends or reads a tenant identifier as an authority source.
