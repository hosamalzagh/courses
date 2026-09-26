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
- **Token ownership:** This file records accepted token values; `apps/web/app/globals.css` is the runtime source. They change together. Filament uses its own compatible panel theme until a shared theme is needed.

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

One primary action per form. Create actions sit at the table header’s left edge in RTL; save and cancel share a footer at the bottom of their owning form. `Button.tsx` reserves the idle label’s geometry while showing a pending label. Destructive actions are separated and require explicit confirmation when introduced. Busy buttons keep their dimensions and say what is happening.

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

## Shared application frame

`CenterShell` owns the sticky route header (title, breadcrumbs, description and authorized page actions). Every admin workspace supplies its title and actions; headings are not repeated in the content. The sidebar has a separately scrollable navigation region and a fixed bottom region for settings, account security, collapse, theme and sign out. Mobile uses the same regions inside its drawer. Content uses 16/24px spacing; table headings and toolbars use 12/16px. Settings and invitation header actions target their owning forms with native form associations; row and security workflow actions remain with their contextual forms.

Sidebar footer uses compact settings links, one identity row and a 44px icon action row (collapse, theme, sign out). Icon buttons retain Arabic accessible names and tooltips; mobile reuses the same account component without desktop collapse.
