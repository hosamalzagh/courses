---
version: alpha
name: "Courses Centers"
description: "A quiet Arabic operations desk for educational centers and their independent branches."
colors:
  ink: "#203A2E"
  body: "#5B7063"
  accent: "#087952"
  accent-strong: "#065E41"
  accent-soft: "#E7F5ED"
  paper: "#F4F8F5"
  surface: "#FFFFFF"
  border: "#DCE7DF"
  amber: "#8C641A"
  danger: "#B72F3F"
typography:
  sans:
    fontFamily: "IBM Plex Sans Arabic, Arial, sans-serif"
  mono:
    fontFamily: "IBM Plex Sans, ui-monospace, monospace"
rounded:
  DEFAULT: "0.75rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1.25rem"
spacing:
  sm: "0.5rem"
  md: "0.75rem"
  DEFAULT: "1rem"
  lg: "1.5rem"
  section-gap: "2rem"
  page-max: "80rem"
components:
  button: {}
  card: {}
  input: {}
---

# Courses Centers Design System

## Overview

### Creative North Star

The branch register in a center office: clear labels, independent branch records, and an obvious line of responsibility. The right-hand navigation establishes the center workspace; consistent tabular registers keep branches, memberships, invitations, and changes readable. No decorative metrics stand in for operational data.

### Product context and register

- **Audience and job:** Arabic-speaking center owners, administrators, and branch staff checking their current authority and maintaining branches.
- **Usage:** Frequent desktop administration with usable narrow-screen access. Data is operational and may be private.
- **Register:** Product. Auth screens are deliberately calm; the administration screens are denser.
- **Anti-references:** Avoid marketing hero cards, decorative education clip art, and generic metric tiles that imply data not yet present.
- **Token ownership:** This file records accepted token values; `apps/web/app/globals.css` is the runtime source. They change together. Filament retains its default panel theme through `apps/api/resources/css/filament/admin/theme.css`; this adapter compiles the utilities used by custom audit detail views without replacing the panel palette or typography.

## Colors

Paper and surface keep long forms legible. Ink carries headings, body carries supporting text, green marks the available action and focus, amber marks pending states, and danger is reserved for denied or failed states. Borders separate records without heavy shadow. The owner approved proposal 3's green palette on 2026-09-26, with light and dark modes. A host-only `courses_theme` cookie stores only this display preference; the server renders the correct theme before hydration.

| Token | Light | Dark |
|---|---|---|
| Ink | #203A2E | #E5F1E9 |
| Body | #5B7063 | #A6BCB0 |
| Accent | #087952 | #80D7A9 |
| Accent strong | #065E41 | #AFE7C9 |
| Accent soft | #E7F5ED | #244734 |
| On accent | #FFFFFF | #12211C |
| Paper | #F4F8F5 | #12211C |
| Surface | #FFFFFF | #1B2D24 |
| Raised surface | #EDF4EF | #21372C |
| Border | #DCE7DF | #32483B |
| Input border | #7E9787 | #6E8979 |
| Warning / background | #8C641A / #FFF5E3 | #E5C180 / #3A3429 |
| Danger / background | #B72F3F / #FFF0F2 | #FF99A5 / #40252D |
| Scrollbar / hover | #819B8B / #5B7063 | #6E8979 / #A6BCB0 |

The auth introduction retains #122D22 with #E5F1E9 text and #B9D0C2 supporting text in both modes. Overlay and shadow use #12211C at 60% and 19% opacity. Runtime CSS owns all values.

## Typography

IBM Plex Sans Arabic is used for Arabic interface text; IBM Plex Sans is used for Latin identifiers and technical labels. Headings are compact and strong, body copy is 16px with a 1.7 line height, table content is 14px, and metadata is 12px. Long emails and domains can wrap.

## Layout

The content is at most 80rem wide. Desktop navigation is 15.5rem on the right and collapses to 5rem; below 901px it becomes a modal navigation drawer. Spacing follows 8/12/16/24/32px. Tables own horizontal overflow; the document owns vertical scrolling. Forms use one column on narrow screens and two only where labels remain adjacent to inputs.

## Elevation & Depth

Use borders and tonal changes. Shadows appear only for active overlays; static records remain flat.

## Shapes

Controls use 0.5rem corners, cards 0.75rem, and large auth surfaces 1.25rem. Lines are one pixel and do not carry decoration alone.

## Components

### Foundational visual states

Hover changes tone, keyboard focus uses a visible green ring, disabled actions retain their label and explanation, pending actions keep their width, and errors use text as well as color. Reduced motion removes transitions.

### Buttons and actions

One primary action per form. All admin page actions, including create, save, cancel, edit, delete, import, export, print, status, sharing and security workflows, live in the shared sticky page header. Submit actions target their owning forms with native `form` associations. Row entry points and table/dialog controls use the same official components. `Button.tsx` reserves the idle label’s geometry while showing a pending label. Destructive actions are separated and require explicit confirmation when introduced. Busy buttons keep their dimensions and say what is happening.

### Navigation and data display

The center name and active membership remain visible in the header. `CenterShell.tsx` owns permission-aware navigation, theme controls, mobile drawer and sign-out. `DataTable.tsx` owns semantic headers, search/clear, column controls, draft filters, compact spacing and pagination. Branch records show their name, code, address, and allowed actions. All Next.js tables use fixed compact density (8px row padding), with no density chooser. The shared toolbar contains search plus «الأعمدة» and «الفلاتر». Column visibility and order persist in host-only one-year cookies per signed-in user and table; only schema keys are stored. The identifying column stays visible and actions stay visible at the last position. Headers support drag and RTL-aware Alt+Arrow reordering; popup arrow buttons provide a touch and keyboard alternative. Filters open a draft panel with apply/clear and operate independently of column visibility. Ten records appear per page; all queries filter only the authorized payload already loaded. Audit explicitly limits that scope to the most recent 50 events. Empty lists lead to the permitted next action.

### Forms and overlays

Fields have persistent labels, useful autocomplete, inline errors, and no native blocking alert. Shared field and notice components own the interaction style.

### Iconography

Text labels carry meaning. Small line icons may support labels but never replace them for primary controls.

### Motion

Only state changes receive a short transition. No ambient animation or staged reveal on administrative data.

### Content and data visualization

Arabic copy names the center and branch explicitly, in line with `CONTEXT.md`. No invented student or financial metrics appear in the first release.

## Do's and Don'ts

- **Do:** Keep permission outcomes specific to the current center and branch.
- **Do:** Show loading, denied, expired, and empty states in plain Arabic.
- **Don't:** Show controls that imply unbuilt modules or roles.
- **Don't:** Cache private page data across requests or centers.

## Student profile expansion — specification #55, 2026-09-27

Design decisions synthesized into [specification #55](https://github.com/hosamalzagh/courses/issues/55) at the owner's request on 2026-09-27; this section describes planned work rather than the implemented student register. The owner approved real-browser acceptance through Laravel/PostgreSQL and focused HTTP tests for concurrency, isolation, and identity/attachment access:

- The student profile supports children, school students and adults. Guardian information is optional according to the student.
- The profile starts with a summary showing the student photo, name, internal number, contact method, current study and attendance/debt alerts within the employee's authority.
- Detail is organized into tabs: personal data, study, attendance, financial account, and notes/attachments. Each section respects the employee's permissions.
- Approved personal fields: photo, date of birth with calculated age, gender, address, email, and place of study or work. These are optional; the name remains required and the internal student number is assigned automatically.
- The owner also requested phone, WhatsApp follow-up number, Sinjapp follow-up number, alternative number, school, specialization, data collection source and additional identification fields.
- Egyptian national ID and passport number are approved as optional fields. The national ID supplies the birth date used to calculate age. A conflict with an entered or already stored birth date is shown and must be corrected before saving; a stored date is not silently replaced. A passport requires a separately entered birth date to calculate age.
- City, educational qualification, profession, data collection method and discovery source are configurable selection lists managed by the center administrator; used choices are retained when disabled. Initial examples from the reference images are profession (student, graduate, employee), collection method (Facebook, data, phone contact, in-person visit), and discovery source (Facebook, friends, flyer, other). School/place of study or work and specialization are free text. The collection method is separate from the identity of the employee who entered the data, which is recorded automatically.
- Multiple contact parties are approved, each with a name, relationship to the student, and phone, with one primary contact. Guardian information remains optional, and siblings may share the same contact phone. Each phone identifies its contact party; staff select the number for each follow-up channel, and the same number may serve phone, WhatsApp and Sinjapp.
- The student profile has exactly two states: active and suspended. Suspension prevents bookings, attendance in existing study, and makeup participation until it is lifted. History is preserved, and payments toward debt remain possible. The center owner or center administrator suspends/reactivates with a recorded reason. Suspension periods are visible and excluded from automatic absence; missed requirements remain incomplete for study completion. Study/group states are independent, with future exam participation states also independent.
- The primary barcode represents the same number as the internal student number. The center selects the sequence starting number, and each new student across all its branches receives the next number, increasing by one; previous numbers remain unchanged. A secondary barcode defaults to the label "الباركود الإضافي", can be renamed and enabled/disabled, and is entered manually. National ID and additional barcode are unique per center. An additional barcode cannot equal another student's primary barcode, so scanning selects one profile. Sequence changes do not renumber existing profiles or reissue previously used numbers. Contact phones may repeat.
- `skillcard` is no longer a built-in field. The center owner and center administrator may configure additional fields shared by all branches, which registration employees fill in. Supported types are text, number, date, selection list and yes/no; configuration includes required/optional status, display order and classification as general or identity data. Reading an identity field requires both authorized profile access in a linked branch and the identity grant; editing requires profile-management authority there and the identity grant. No custom field is exposed by cross-branch search. Disabling preserves existing values without requiring the disabled field on later saves, and changing a field's type after a value was stored requires a new field. Active required fields apply when creating or editing profile data; an incomplete old profile displays a warning without blocking attendance or payments.
- Expanded data does not broaden cross-branch search: its results keep only the current name, internal number and summary phone, never named contacts, channel owners, identity data or custom fields. General data is visible inside the authorized profile. National ID, passport and identity attachments require an additional permission granted by the center owner to specific employees, together with authorized profile access in a linked branch; the center owner and administrator have center-wide access by default. Financial visibility keeps its existing independent permissions.
- Multiple image/PDF attachments are approved, each up to 10 MiB (10 × 1024 × 1024 bytes), with a title and classification as identity or general. Preview and download require current profile read access; identity attachments also require the identity grant. Upload requires profile-management authority, plus the identity grant for identity attachments. Replacement preserves the previous version. Removal archives the attachment, and the center owner or administrator can restore it.
- Creation and editing use a dedicated page grouped into personal data, contact, study/work background, source and custom fields. Staff may save with the name, an authorized branch and required custom fields, then complete optional data later. Saving opens the profile with its summary and tabs; photo and attachments are available from the profile.
- Notes are optional on each student event, such as course registration, attendance/absence or a financial movement. They retain author, time and revision history, appear within the event and the profile notes tab, and inherit the event's permissions. A payment note is not visible without financial access. Notes do not replace mandatory correction/suspension reasons. Events show a small "إضافة ملاحظة" action rather than an always-expanded editor. Staff may mark a note as important; important notes appear as compact authorized summary lines, while ordinary notes stay within the event and notes tab. Removing importance preserves the note.
- Each student has a sharing choice controlling discovery by other branches. Discovery additionally requires the center search setting to be enabled and the employee to have center-search permission. Results contain name, internal number and summary phone only; named contacts and follow-up channel owners remain inside the authorized profile, while study and financial records keep their branch permissions. The center configures the starting default instead of enforcing a universal off value. Registration staff who may edit the profile, and the center owner/administrator, may change its choice, with audit history. The default initializes new profiles; later default changes preserve each existing profile's saved choice rather than applying a bulk access change.
- Existing academic and financial tickets supply their respective workflows; their presence in the planned profile does not imply implementation. The specification publishes this design direction; implementation and automatic outbound WhatsApp/Sinjapp messages are separate work. Channel numbers are profile data in this design.

### Planned page structure

The profile summary contains the photo, name, internal number/barcode, active/suspended state, authorized branches, primary contact, current study, authorized attendance/debt alerts and compact important notes. Action availability follows the relevant permissions: edit data, print barcode, suspend/reactivate, or open the owning study/payment workflow.

| Tab | Content |
|---|---|
| البيانات | Personal/identity data, contact parties and channel numbers, study/work background, sources, sharing choice and custom fields |
| الدراسة | Authorized registrations, groups, attempts, waiting/withdrawal/transfer history and completion status |
| الحضور | Authorized attendance, absences, makeup participation and suspension periods |
| الحساب المالي | Authorized charges, payments, allocations, available balance and debt |
| الملاحظات والمرفقات | Event-linked notes and versioned attachments, each within its own access scope |

Required creation data is the name, at least one authorized branch and the center's required custom fields. Optional identity/contact/background data may be completed later. Source lists remain configurable. Empty or unavailable sections reflect actual feature and permission state; future exams remain outside this build's scope.

## Shared application frame

`CenterShell` owns the sticky route header (title, breadcrumbs, description and authorized page actions). Every admin workspace supplies its title and actions; headings are not repeated in the content. The sidebar has a separately scrollable navigation region and a fixed bottom region for settings, collapse, theme and sign out. Mobile uses the same regions inside its drawer. Content uses 16/24px spacing; table headings and toolbars use 12/16px. Every admin form follows the same header action contract, including expanded row editors and security workflows. Independent settings forms register their actions together without replacing one another.

Sidebar footer uses one compact settings link, one identity row and a 44px icon action row (collapse, theme, sign out). Icon buttons retain Arabic accessible names and tooltips; mobile reuses the same account component without desktop collapse. The settings workspace uses the shared route-backed tabs in a compact surface and divided two-column setting rows; the right column explains the setting, while the left contains its controls. Rows stack on narrow screens. Tables remain the canonical view for branch and choice registers.

The admin layout retains the sidebar, header and footer across internal navigation. Server-rendered `CenterPage` owns each workspace’s main content structure and read-only material. Small client registration components publish its header and interactive actions; `CenterLayout` owns the persistent frame. Route entrypoints stay server components; request data loads in separate async server components and forms/tables hydrate in dedicated controls. `PrefetchLink` preloads the full authorized SSR destination on hover, keyboard focus or pointer intent. Browser prefetch retention is limited to 30 seconds, and successful mutations refresh the router cache. Pending navigation retains the current content until the destination is ready and displays a fixed progress strip that occupies no layout space. Desktop collapse state survives route changes. `admin-header.tsx` supplies the same title and description before and after hydration; the header reserves its action column on desktop and action row on mobile.

Arabic interface fonts use `next/font/local` with early font preload and metric-adjusted fallbacks. Authentication pages keep the shared shell on the server and hydrate only their forms. Authenticated routes remain request-rendered SSR because sessions, permissions, theme and tenant data are request-specific; no page forces `force-dynamic` or uses a client page entrypoint.

## Official component source

The owner confirmed on 2026-09-27 that Next.js uses official shadcn/ui components, installed with its CLI from `@shadcn`, with the Base UI Nova style and RTL enabled. `apps/web/components/ui` owns the generated primitives. Shared application adapters preserve domain behavior; they compose those primitives instead of implementing alternative button, input, field, checkbox, radio, alert, confirmation, sheet, table or popover styles. The approved IBM Plex fonts and green light/dark tokens remain the theme source. Page actions register through `CenterPageActions`/`CenterHeaderActions`; controls never introduce a second save/cancel footer.

Implementation and review rules for current and future screens, including SQL and frontend performance acceptance, are mandatory in `docs/agents/ui-and-performance.md`, linked from the root and web `AGENTS.md`.
