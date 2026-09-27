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
| Form | `apps/web/components/FormField.tsx`; Filament schemas in Landlord | Persistent label, hint, and accessible error slot | Center fields; Landlord schema fields | Browser login and invitation flow |
| Scrollbar | `apps/web/app/globals.css`; Filament panel theme | Global visible scrollbar; stable width | Center light/dark themes; Landlord panel theme | Computed style check |
| Feedback | `apps/web/components/InlineNotice.tsx`; Filament notifications | Text status in a live region | Inline center status; panel notifications | Browser failure and success paths |
| CRUD | Laravel HTTP API plus `apps/web/app/admin`; Filament resource pages | Server authorization and existing save destinations | Center branch actions; Landlord resources | Browser create and edit flow |
| Staff grants | `apps/web/app/admin/members` | Center roles and per-branch roles remain separate | Center and branch roles | Real PostgreSQL integration test |
| Student profiles | `apps/web/app/admin/students`, tenant student HTTP operations | GitHub issue #21; ADRs 0001, 0003 and 0022 | Create / reuse / edit / direct protected profile | HTTP isolation, retry recovery and real-browser journeys |
| Center student search | `apps/web/app/admin/student-search`, tenant policy and search HTTP operations | GitHub issue #22; ADR 0003 | Disabled / enabled basic-only search | HTTP scope, retry policy and browser acceptance |
| Instructor profiles | `apps/web/app/admin/instructors`, tenant instructor HTTP operations | GitHub issue #23; ADRs 0001, 0003 and 0021 | Create / reuse / edit / direct protected profile | HTTP isolation, recovery and browser acceptance |
| Branch curriculum | `apps/web/app/admin/curriculum`, tenant curriculum HTTP operations | GitHub issue #24; ADRs 0005, 0021 and 0024 | Hierarchy / first plan / protected detail | HTTP immutability, bounded reads and browser acceptance |
| Settings and audit | `apps/web/app/admin/settings` and `audit`; `PlatformAuditLogResource` | Server-provided initial data, no shared private cache | Center audit; owner-only platform audit | Authenticated browser and query meter |
| Select/Listbox | Filament Select and SelectFilter in Landlord | Arabic labels and keyboard-accessible library popup | Authored searchable filters; native records-per-page control | Live filter popup and integration tests |
| Date | Filament DatePicker; `PlatformAuditLog::localTime` | Arabic calendar; displayed times and inclusive date ranges use Africa/Cairo; storage stays UTC | Authored date filter; formatted event time | Cairo midnight boundary integration test |
| Audit details | Filament Action modal and `filament.platform-audit-details` | Escaped human-readable values; only safe fields, no credential values | Before/after changes; honest legacy fallback | Modal integration and browser checks |

Table row selection, date controls, and authored select boxes are absent from the center screens. Shared table search, applied column filters, scope filter and page use per-table URL keys; search or filter changes reset the page, and shrinking results clamp it. Filters apply to already-authorized loaded records and add no API request. Compact density is fixed; legacy density URL parameters are removed and no chooser is rendered. Clearing search restores focus to its field. Audit timestamps and invitation expiry dates use Africa/Cairo. Landlord audit filters reuse Filament controls; the audit page sets Arabic locale for its initial render and Livewire updates. Search, filters, and sort use Filament URL state. Search clearing returns focus to its field. Platform audit remains restricted to the platform owner and reads central data only, within six application SQL queries per page. New audit changes record only actual safe-field differences; historical events never invent missing before/after values.

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

`app/admin/layout.tsx` retains `CenterLayout` during client navigation. `CenterPage` renders the main structure on the server; small client bridges register the current permissions, title and interactive header actions. Route data loads in separate async server components; only controls and interactive navigation use client modules. Navigation, breadcrumbs, profile links and batch links use `PrefetchLink` to warm full SSR destinations on hover, keyboard focus or pointer intent, with a 30-second browser retention window. Successful mutations refresh the router cache. Pending navigation retains the current content until the destination is ready, with a fixed progress strip and accessible status on the selected link. The sidebar/header DOM and desktop collapse state remain intact. Server and client headers share `admin-header.tsx`; desktop reserves the action column and mobile reserves the action row so hydration does not change header geometry. The request URL is supplied by the admin proxy so the layout and page share one authorized server payload, deduplicated only within the current React server render. Private responses are not stored in a shared server cache; prefetches live only in the signed-in browser session and current origin. Confirming an unsaved-changes warning uses the same client navigation for internal destinations.

## Student profile journey — issue #21

The student register reuses the shared frame, fields, feedback and table. Its server search covers authorized files only; each HTTP batch contains at most 50 files, with separate bounded branch pages. Shared table search, filters and ten-row pagination apply to that loaded batch, and the interface states this scope. Global search and batch page persist in the URL. Direct file links recheck current membership and visibility.

Creation automatically assigns an immutable center-local number without a login account. Similar authorized name/contact data produces a warning with links to existing files; staff may explicitly save a separate person. Editing can add authorized branch associations and preserves existing associations. A lost creation response retains the same submission identity; changed retry data requires recovering the original saved file before editing it. Revision conflicts load the current profile rather than silently replacing newer data. Basic changes and each branch association appear in the existing authorized audit with actor, scope, timestamp and before/after values.


## Optional center student search — issue #22

`/admin/student-search` uses the shared frame, fields, feedback and table. The center setting starts disabled; center managers change it, while the independent search grant controls use outside assigned branches. Search exposes basic identity/contact only. A hidden-branch match has no edit action or protected-file link, including similarity warnings in the ordinary student form. Ordinary profiles retain their existing authorized branch scope. Policy conflicts reload current state; identical retries do not add audit events. The policy change preserves profiles and history. Sources: issue #22 and ADR 0003.

## Instructor profile journey — issue #23

`/admin/instructors` uses the student journey's shared frame and primitives. Staff create a center profile without a login, then reuse it by adding authorized branch associations. Existing associations remain intact; responses and audit details expose only the permitted scope. The academic role controls writes, and each protected request rechecks authority. The shared `UnsavedChangesGuard` protects modified forms when following navigation links and uses the browser lifecycle guard for page unload. Explicit cancel keeps the established discard behavior. Lost responses retain the submission identity and recover the original file; revision conflicts load the latest profile. Server batches are bounded and table controls apply to the loaded batch. Sources: issue #23, ADRs 0001, 0003 and 0021.

## Branch curriculum journey — issue #24

`/admin/curriculum` keeps the Course → Stage → Level hierarchy within its owning branch and uses the shared frame, fields, feedback and tables. The first plan has a stable version identity and required complete numbered lectures with content, optional title and planned hours. The shared `UnsavedChangesGuard` protects modified forms during navigation. Saving disables the owning form and preserves entered values on failure; revision conflicts recover the current plan. Used study content stays immutable; later version and group journeys must preserve this protection and test their integration. Sources: issue #24, ADRs 0005, 0021 and 0024.

Arabic interface fonts use `next/font/local` with early font preload and metric-adjusted fallbacks. Authentication pages keep the shared shell on the server and hydrate only their forms. Authenticated routes remain request-rendered SSR because sessions, permissions, theme and tenant data are request-specific; no page forces `force-dynamic` or uses a client page entrypoint.

## Horizontal workspace sections — owner correction #93

`WorkspaceSections.tsx` composes official Base UI/shadcn Tabs for peer views of the same workspace. The selected `tab` is server-validated URL state and survives refresh, Back and batch navigation. Returning to a student/instructor register clears global search parameters and resets its result page. Native links reuse intent prefetch and the existing unsaved-change guard; arrow keys move focus and Enter/Space activate explicitly. Only the selected panel mounts workflow controls and registers header actions. A narrow tab strip scrolls horizontally with visible scrollbars; panels retain natural document height. API authority, tenant boundaries and the six-query page budget remain unchanged.

Students/instructors start at their compact register with a separate global-search view. Center student search starts at search/results; only managers receive the policy/settings view. Curriculum displays one of courses, stages or levels/plans; successful hierarchy creation or committed-submission recovery opens the corresponding view while retaining each collection batch from the URL. Leaving a section aborts pending plan/instructor recovery reads and releases their busy state immediately. Late completion cannot open an editor or overwrite a newer request, including a leave-and-return sequence. Editors replace the visible table while its state remains retained in the active panel, and preserve fields on failure, with cancel focus restored to the originating row/header action. Student row sharing uses a compact action with its state in both visible text and accessible name; full profile sharing keeps its existing summary and header controls.

The center-search settings view retains search parameters in the URL for returning to results, but its page and shared layout fetch the same policy payload without running the hidden search. Browser Back/Forward closes an open policy confirmation when the selected view changes; it never submits a confirmation left open in another view. Opening a level detail carries the current curriculum collection pages, and its return link reopens the levels tab at that batch; a direct detail URL returns to the first levels batch.
