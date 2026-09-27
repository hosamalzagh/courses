# Student contacts and owned follow-up channels (#58)

Parent spec: #55 stories 16–22; ADR 0022 retains the internal student number as identity and allows shared contact numbers.

Contacts are bounded at twenty per profile. Each has a stable local UUID, name, relationship, textual phone and exactly one primary contact when the list is nonempty. No guardian is required. The four optional channels (primary, alternative, WhatsApp, Sinjapp) each carry an explicitly selected owner from this student's contacts and a textual number; one owner/number can serve multiple channels and multiple students.

The tenant migration adds bounded JSONB contact/channel data to the existing profile. It leaves the original phone, normalized phone search, student identity, number, request hash, creator, timestamps and audit unchanged. That original number is exposed as `legacy_phone`, without inferring a person. Summary `phone` is the selected primary channel, otherwise the primary contact's phone, otherwise the old number. Old searches keep matching the legacy number; register, similarity and authorized center discovery also match contact/channel numbers. Cross-branch discovery still returns only its existing basic fields, never contacts or channel owners.

Profile writes use the existing tenant transaction, revision lock, current membership and branch authorization. Contact IDs refer only to the submitted student's list. Contacts/channels must be provided together; omitting them on an older client preserves existing data. Omitted legacy phone on edit is preserved; older clients echoing an owned summary phone cannot overwrite the original phone. New UI creates named contacts; the old phone editor remains only for existing unassigned numbers. Identical retries do not add revisions or audit entries. No send, queue, external-account or messaging-provider integration is added.

The shared header owns add/remove/save/cancel/recovery actions. Removing a named contact uses the shared confirmation dialog, explains removal of its channels, and restores focus on cancellation. Field validation and disabled states use the existing shadcn adapters. The server profile shows names, relationships, channels, explicit primary contact and unassigned legacy data. Safe branch audit shows the before/after public contact data within existing audit authority.

## Acceptance evidence

- Red HTTP and browser failures were observed before the contact storage, multi-number similarity and UI slices were implemented.
- Full Laravel suite: 107 tests, 2533 assertions; focused related suites: 39 tests, 1042 assertions. Focused profile suite includes shared sibling numbers, owners on all channels, leading zeros, ambiguous/foreign owners, textual zero, stale revisions, replay, current branch rights and repeatable existing-center migration. Existing tenant isolation remains covered.
- Five dedicated real browser journeys use production-built Next.js, Laravel, isolated PostgreSQL, real login/session and CSRF: adult profile create/edit, concurrent requests and completion of old numbers, center isolation and next-request revocation, retained conflict inputs and header recovery, RTL/keyboard/validation/cancel/light/dark/mobile, full SSR measurements and warm navigation.
- Actual SSR SQL: register, new, profile and edit are each 6. Intent-prefetched warm navigation stays within 6, keeps the same header and sends no document request. Missing measurements fail acceptance.
- Existing shared-number browser journey now enters named contacts and still permits an independent sibling profile after the similarity warning. The cached-editor, numbering/sharing/suspension and SQL journeys remain integration gates.
- Lint, TypeScript and production build pass. Two-axis review has zero remaining Spec and Standards findings after adding removal confirmation and shared phone-list normalization. Desktop light and dark plus mobile dark screenshots were visually inspected.
- No production deployment. Later #60/#61/#62 and academic/financial work must preserve contact data; #82 owns the final expansion-wide integration acceptance.

## Repeatable local acceptance

Reuse the disposable alpha/beta/staff fixture and proxy described in `docs/student-profile-choices-acceptance.md`, after applying tenant migrations. A fresh fixture receives this migration during normal provisioning; an existing fixture receives it through `courses:migrate-centers`. Never use production databases.

From `apps/web`, set `COURSES_CONTACTS_CREDENTIALS` to the absolute mode-0600 fixture credential file, `COURSES_CONTACTS_ORIGIN` to the alpha proxy origin (default `http://alpha.courses.test:8057`), and `COURSES_CONTACTS_READ_LOG` to the JSONL proxy log including SSR requests. Run `npx playwright test student-contacts.spec.ts`. Without disposable credentials this suite is skipped.
