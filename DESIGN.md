---
version: alpha
name: "Courses Centers"
description: "A quiet Arabic operations desk for educational centers and their independent branches."
colors:
  ink: "#17313D"
  body: "#38545C"
  teal: "#126D7E"
  teal-soft: "#E2F0F1"
  paper: "#F7F9F7"
  surface: "#FFFFFF"
  border: "#D7E2E2"
  amber: "#A96B22"
  danger: "#A33131"
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
  section-gap: "2rem"
  page-max: "72rem"
components:
  button: {}
  card: {}
  input: {}
---

# Courses Centers Design System

## Overview

### Creative North Star

The branch register in a center office: clear labels, independent branch records, and an obvious line of responsibility. The dashboard's branch list uses one restrained vertical spine to show that the branches belong to one center while keeping each record distinct.

### Product context and register

- **Audience and job:** Arabic-speaking center owners, administrators, and branch staff checking their current authority and maintaining branches.
- **Usage:** Frequent desktop administration with usable narrow-screen access. Data is operational and may be private.
- **Register:** Product. Auth screens are deliberately calm; the administration screens are denser.
- **Anti-references:** Avoid marketing hero cards, decorative education clip art, and generic metric tiles that imply data not yet present.
- **Token ownership:** This file records accepted token values; `apps/web/app/globals.css` is the runtime source. They change together. Filament uses its own compatible panel theme until a shared theme is needed.

## Colors

Paper and surface keep long forms legible. Ink carries headings, body carries supporting text, teal marks the available action and focus, amber marks pending states, and danger is reserved for denied or failed states. Borders separate records without heavy shadow. The current release uses a light theme.

## Typography

IBM Plex Sans Arabic is used for Arabic interface text; IBM Plex Sans is used for Latin identifiers and technical labels. Headings are compact and strong, body copy is at least 16px with generous Arabic line height. Long emails and domains can wrap.

## Layout

The workspace is at most 72rem wide, with a narrow contextual rail on desktop and a stacked layout on phones. The branch spine is the only expressive device. Forms use one column on narrow screens and two only where labels remain adjacent to inputs.

## Elevation & Depth

Use borders and tonal changes. Shadows appear only for active overlays; static records remain flat.

## Shapes

Controls use 0.5rem corners, cards 0.75rem, and large auth surfaces 1.25rem. Lines are one pixel and do not carry decoration alone.

## Components

### Foundational visual states

Hover changes tone, keyboard focus uses a visible teal ring, disabled actions retain their label and explanation, pending actions keep their width, and errors use text as well as color. Reduced motion removes transitions.

### Buttons and actions

One primary action per form. Destructive actions are separated and require explicit confirmation when introduced. Busy buttons keep their dimensions and say what is happening.

### Navigation and data display

The center name and active membership remain visible in the header. Branch records show their name, address, and allowed actions. Empty lists lead to the permitted next action.

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
