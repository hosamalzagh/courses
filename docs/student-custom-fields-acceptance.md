# General student custom fields — #62

## Model and authorization

A center manager (owner or administrator) defines center-local fields with UUID keys, Arabic labels, text/number/date/select/yes-no type, position and requiredness. Registration employees enter values through their authorized student profiles; definition management never follows from registration. Definitions and values live only in the tenant database and are shared by its branches. Values cannot replace core profile columns, numbering, status or financial records.

Text keeps up to 1000 characters. Numbers are decimal strings (optional minus, up to 20 integer digits and 10 fractional digits) so JavaScript cannot round identifiers or precision. Dates use valid YYYY-MM-DD calendar dates; custom dates may be future dates. Selection lists initially contain up to 100 distinct text options. Yes/no distinguishes unfilled from explicit false; zero and false satisfy requiredness. Clearing an optional value removes the current value; omitted values preserve it. General edits, including unchanged submissions, validate current required fields; retries of an already-created request recover the original profile instead of creating another one.

Definition creation uses a stable UUID/request hash; definition edits use row revisions; profile writes use the existing profile revision plus the current definition revision. Definition/profile writes share the center lock, refresh membership/permissions at execution and commit values/profile/audit together on the tenant connection. No central/tenant atomic-write claim is made. General audit contains changed field UUIDs/counts, never custom values; definition audit records label/type/order/requiredness. Unchanged retries do not add events or revisions, and unchanged values retain timestamps.

## Forms, bounded reads and old profiles

Manager, create/edit and read-only detail use the existing shell, official shared field adapters, DataTable and native unique header form ownership. Definition pages and progressive form/detail reads contain 50 fields, with one lookahead. Initial definitions compose into the existing workspace SQL; detail values match that page. Loading subsequent existing values does not count as a user edit and never overwrites an edited value. A definition conflict preserves all input and offers current-definition loading in the header; a profile conflict retains the existing explicit profile recovery path.

Required fields added later leave existing files unchanged, with a missing-count warning. Sharing and suspension are independently executable while incomplete. This delivery's combined profile journey retains custom text, passport, manual barcode, internal number, contacts, sharing and status across general edits and browser Back. Attendance/payment/important-note interactions remain with their later owning tickets and final #82 acceptance.

The migration preserves existing profiles, requests, identities, contacts, codes and settings. It fills only a missing settings singleton, using the already-resolved center's owner email; existing settings are not overwritten. This also repairs historical centers where an absent settings row made the create form fail on null barcode settings.

## Evidence and boundaries

- HTTP: 5 focused public Laravel/PostgreSQL tests, 214 assertions: management vs registration, all types and precision, current requiredness, no-op/replay/stale definitions, branch/center isolation, progressive reads, grant revocation, migration and audit-failure rollback/retry.
- Laravel full suite: 122 tests / 3036 assertions passed. Pint, ESLint, TypeScript and production build passed.
- Real browser: six dedicated journeys cover field creation/input, all five types, invalid date focus and retained work, old missing warnings with independent status/sharing, concurrent creates/edits, current authorization from an open editor, recovery, 50-field paging, cancellation/focus/native header forms, desktop/mobile RTL light/dark, and SSR/warm navigation.
- Actual total SSR application SQL: definition page and page two 5; student register/new/detail/edit 6. Progressive reads stay within 6. Numeric meter headers are required; missing is not zero. Warm navigation retains the header and requests no extra document.
- Classification, disabling definitions/options, used-type changes and their preserved history belong to #63; this ticket implements general fields only. Type/options edits are deliberately unavailable until that preservation workflow. Attachments remain #65; final integration #82. No production deployment or external messages.

## Reproduce locally

Use the disposable alpha/beta/staff fixture and proxy in `docs/student-profile-choices-acceptance.md`, after tenant migrations. From `apps/web`, set `COURSES_CUSTOM_CREDENTIALS` to the absolute mode-0600 credential file and `COURSES_CUSTOM_READ_LOG` to the proxy JSONL log including SSR reads, then run `npx playwright test student-custom-fields.spec.ts`. Optional `COURSES_CUSTOM_ORIGIN` defaults to http://alpha.courses.test:8057. The suite skips without the isolated fixture; all fixture profile values are synthetic. Run profile integration with the isolated `COURSES_PROFILE_*` connection safeguards described in `docs/student-manual-codes-acceptance.md`.
