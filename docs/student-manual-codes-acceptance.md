# Manual student barcode (#60)

Parent spec: #55 stories 27–28; ADR 0022 keeps the internal number as the primary identity. The optional manual barcode is a textual center identifier, with a center-chosen label. Owner/admin settings enable, rename and disable it; disabling retains values and their reservations. Editing a code requires current permission to manage that student's file and does not expand branch access.

The tenant migration adds nullable unique `manual_code`, its indexed numeric alias, and revisioned center settings without changing existing IDs, numbers, request hashes, creators, timestamps or contacts. Letters and leading zeros are preserved. Numeric aliases reserve the corresponding primary number, including while disabled. A code may match its own student's primary number, but not another student's number. Allocation checks the next primary number before advancing the sequence; a collision fails with a recoverable Arabic message, without inserting a profile or renumbering anyone.

Create/update/settings writes reuse the current center/member lock and tenant transaction. They check current permissions at execution, serialize competing writes, preserve omitted codes and handle idempotent retries and stale revisions. Errors do not disclose a hidden student's name. Safe branch audit records manual-code changes; center settings audit records before/after enablement and label. No external messaging or production deployment is included.

The register's explicit “الرقم الداخلي / الباركود” search sends `identifier` and returns at most one authorized profile. General name/phone/internal-number search retains its existing shared-contact behavior. Disabled manual codes are not lookup targets. Cross-branch discovery is unchanged. Settings, search and student fields reuse the existing shadcn adapters and shared header forms, with native unique submit ownership and retained inputs/recovery after conflict.

## Acceptance evidence

- Red HTTP and browser failures preceded implementation. Full Laravel: 112 tests / 2644 assertions; focused related suites: 44 / 1153. Public HTTP coverage includes textual zero, duplicate and numeric-primary collisions, future allocation while disabled, current grants, stale revisions, retries and repeatable existing-center migrations.
- Five real barcode browser journeys pass against production-built Next.js, Laravel with four PHP workers, isolated PostgreSQL, real sessions and CSRF. Concurrent creates return one success and one generic conflict; concurrent edits cannot bypass uniqueness. Sequence collision retains UI input and permits an explicit settings/code repair followed by retry.
- Five existing contact browser journeys and four profile integration journeys pass. Code creation/edit retains center choices and contacts; the combined profile keeps its code, primary number, sharing, suspension and contacts through edits and browser Back. Shared-phone warnings still permit distinct students. Cached editors submit through their own header form.
- That integration run exposed deferred contact focus stealing focus from the next field. The shared component now moves focus only if the user has not already moved it; the existing shared-phone journey asserts both name and relationship remain correct.
- Actual ordinary SSR settings/new/profile/edit/identifier search each measure 6 SQL queries including server fetches. Intent-prefetched warm navigation stays within 6, preserves the header and sends no extra document request. Missing or nonnumeric measurements fail acceptance.
- Lint, TypeScript, production build, Pint and diff whitespace checks pass. Desktop light/dark and mobile dark screenshots were inspected; theme screenshots disable transitions to capture the settled state.

## Repeatable local acceptance

Use the disposable alpha/beta/staff fixture and proxy described in `docs/student-profile-choices-acceptance.md`, applying tenant migrations first. Both fresh provisioning and existing-center migration are covered. Never use production databases.

From `apps/web`, set `COURSES_CODES_CREDENTIALS` to the absolute mode-0600 fixture credential file and `COURSES_CODES_READ_LOG` to the proxy JSONL log that includes SSR reads. Optional `COURSES_CODES_ORIGIN` defaults to `http://alpha.courses.test:8057`. Run `npx playwright test student-manual-codes.spec.ts`. The suite skips without the disposable fixture.

Later #61/#62 must preserve these identifiers during identity/custom-field writes. #82 owns final expansion-wide integration with the remaining academic/financial journeys.
