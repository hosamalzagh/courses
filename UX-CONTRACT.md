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

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Workspace navigation | `apps/web/components/CenterShell.tsx` | Permission-aware right sidebar and mobile modal drawer | Expanded / collapsed desktop; mobile drawer | Keyboard, Escape, focus restore, narrow viewport |
| Theme | `apps/web/components/ThemeProvider.tsx` and root layout | Server-rendered light/dark choice in host-only preference cookie | Approved green light and dark palettes | Reload and route navigation |
| Button | `apps/web/components/Button.tsx`; runtime `.button` for existing auth forms | Shared shape, busy geometry and disabled state | Primary / secondary / danger | Pending dimensions and keyboard actions |
| Table | `apps/web/components/DataTable.tsx`, `TablePreferences.tsx`, `TablePopover.tsx` | Compact semantic table, search, draft filters, visibility/order, ten-row paging, URL state | Branches / memberships / invitations / latest 50 audit events | Search clear, boundary paging, themes and mobile overflow |
| Form | `apps/web/components/FormField.tsx` | Persistent label, hint, and accessible error slot | Center fields | Browser login, invitation and student flows |
| Scrollbar | `apps/web/app/globals.css` | Global visible scrollbar; stable width | Center light/dark themes | Computed style check |
| Feedback | `apps/web/components/InlineNotice.tsx` | Text status in a live region | Inline center status | Browser failure and success paths |
| CRUD | Laravel HTTP API plus `apps/web/app/admin` | Server authorization and existing save destinations | Center branch and student actions | Browser create and edit flow |
| Staff grants | `apps/web/app/admin/members` | Center roles and per-branch roles remain separate | Center and branch roles | Real PostgreSQL integration test |
| Student profiles | `apps/web/app/admin/students`, tenant student HTTP operations | GitHub issue #21; ADRs 0001, 0003 and 0022 | Create / reuse / edit / direct protected profile | HTTP isolation, retry recovery and real-browser journeys |
| Settings and audit | `apps/web/app/admin/settings` and `audit` | Server-provided initial data, no shared private cache | Center audit | Authenticated browser and query meter |

Table row selection, date controls, and authored select boxes are absent from the center screens. Shared table search, applied column filters, scope filter and page use per-table URL keys; search or filter changes reset the page, and shrinking results clamp it. Filters apply to already-authorized loaded records and add no API request. Compact density is fixed; legacy density URL parameters are removed and no chooser is rendered. Clearing search restores focus to its field. Audit timestamps and invitation expiry dates use Africa/Cairo.

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
| Create/edit student | Disable save, retain fields; review authorized similar files | Refresh the owning list with status | Retain fields; recover the original submission or load the current revision before editing |
| Reset password | Disable action | Show success with login link | Keep email and show error |

## Permission and session behavior

- The API is the authority. The interface uses `/api/v1/center/user` only for current-center display decisions and never grants access locally.
- A forbidden branch action shows an explicit inline 403 message; a direct route to a forbidden page shows a clear state.
- A 401 response during protected client actions sends the user to login. A suspended center shows a distinct unavailable state. A center page is fetched with `no-store`.
- Role changes are reflected by the next protected request. The UI refreshes after each mutation.
- Cookies stay host-only; the browser never sends or reads a tenant identifier as an authority source.

## Approved phase 2 frontend foundation — 2026-09-26

The owner selected proposal 3’s green colors, light/dark modes, collapsible sidebar and compact tables with shared column/filter controls (updated by the owner’s decision on 2026-09-26). This applies to the existing Next.js center screens; it does not add unbuilt curriculum or billing features. Every table uses the shared template. Create actions occupy the header’s left edge in RTL. Save/cancel sit at the bottom of the form; dangerous actions have a separate semantic style and retain the existing confirmation.

Mobile navigation uses a native modal dialog with inert background, body scroll lock, Escape dismissal and focus restoration. Desktop collapse preserves localized accessible link names. Theme persists only a validated `light` or `dark` preference, never private data or an authority identifier. Authentication and server authorization contracts above remain authoritative.

Migration coverage: branches, staff/invitations, audit, settings and account security use `CenterShell`; all operational lists use `DataTable`. Auth screens reuse field, notice and theme tokens. The disposable picker is removed after promotion; rollback consists of reverting this frontend foundation, not changing tenant data.

## Unified table controls — 2026-09-26

Every existing and future Next.js operational table uses `DataTable`. `CenterShell` supplies the current user to `TablePreferenceUser`; preference cookies are host-only, scoped to `/admin`, and store only validated column keys. Unknown or malformed saved preferences fall back safely. Hidden columns cannot reveal API data that was not provided. The first identifying column remains visible; action columns are fixed last and cannot be hidden. Newly introduced columns appear by default. Restoring defaults resets visibility and ordering for that user/table only.

`TablePopover` owns authored non-modal panels in the browser top layer: keyboard focus on opening, Escape/outside dismissal, explicit close and trigger restoration, bounded viewport placement and internal scrolling. Column ordering offers header drag, RTL-aware Alt+Arrow and labeled move buttons. No pointer gesture is required on mobile.

Filters use `TableColumn.filterText` as the explicit safe display-value mapping and optional exact scope/status choices. Opening copies applied values into a draft. Closing without applying discards the draft on the next open; apply resets to page one, preserves global search and stores filters in the URL. Clear removes the applied filters while retaining global search. No-results reset clears both. Filters continue to apply to hidden columns and only to the complete authorized payload already loaded (latest 50 for audit). These controls add no API calls. There is no archive control because these center resources do not currently have an archive workflow.

## Shared application frame

`CenterShell` owns the sticky route header (title, breadcrumbs, description and authorized page actions). Every admin workspace supplies its title and actions; headings are not repeated in the content. The sidebar has a separately scrollable navigation region and a fixed bottom region for settings, account security, collapse, theme and sign out. Mobile uses the same regions inside its drawer. Content uses 16/24px spacing; table headings and toolbars use 12/16px. Settings and invitation header actions target their owning forms with native form associations; row and security workflow actions remain with their contextual forms.

Sidebar footer uses compact settings links, one identity row and a 44px icon action row (collapse, theme, sign out). Icon buttons retain Arabic accessible names and tooltips; mobile reuses the same account component without desktop collapse.

## Student profile journey — issue #21

The student register reuses the shared frame, fields, feedback and table. Its server search covers authorized files only; each HTTP batch contains at most 50 files, with separate bounded branch pages. Shared table search, filters and ten-row pagination apply to that loaded batch, and the interface states this scope. Global search and batch page persist in the URL. Direct file links recheck current membership and visibility.

Creation automatically assigns an immutable center-local number without a login account. Similar authorized name/contact data produces a warning with links to existing files; staff may explicitly save a separate person. Editing can add authorized branch associations and preserves existing associations. A lost creation response retains the same submission identity; changed retry data requires recovering the original saved file before editing it. Revision conflicts load the current profile rather than silently replacing newer data. Basic changes and each branch association appear in the existing authorized audit with actor, scope, timestamp and before/after values.
