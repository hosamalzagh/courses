# Phase 2 frontend foundation verification — 2026-09-26

Approved scope: proposal 3 green colors, light/dark modes, collapsible RTL sidebar, shared tables, controls, typography and spacing on existing Next.js center screens.

- ESLint and TypeScript passed.
- Production Next.js build passed.
- Strict frontend audit: zero findings (source roots app, components and lib; excludes vendor/generated files).
- Browser foundation journey passed: theme persistence, table search/clear and restored URL state, density, desktop collapse, mobile drawer/Escape/focus return, no document overflow, create-form focus, confirmations, password visibility and five workspace routes.
- Existing host/session isolation, complete owner/invitation/MFA/CRUD/grants journey and shared-identity isolation passed.
- Query budget: 19 routes checked on cold and warm loads. All <=6 application SQL queries. Ten center routes: branches/security 5, settings/members/audit 6, on both hosts.
- Real in-app browser inspected desktop light/dark and 390px mobile. Mobile document width equaled its content width; table scrolling stayed inside its own region. No browser console warnings/errors observed.

Commands from apps/web:

```sh
npm run lint
./node_modules/.bin/tsc --noEmit
npm run build
npm run test:browser -- tests/frontend-foundation.spec.ts --output /tmp/courses-foundation-results
npm run test:browser -- tests/local-acceptance.spec.ts --grep 'alpha and beta'
npm run test:browser -- tests/owner-invitation.spec.ts tests/page-query-budget.spec.ts tests/shared-identity.spec.ts
```

The integrated run initially found obsolete card selectors and a non-atomic scrollbar-width assertion in the tests. Selectors now follow semantic table rows and their adjacent detail rows; the width assertion checks overflow in one browser evaluation. All five scoped journeys passed in the final verification runs.

Local Herd frontend service was rebuilt/restarted. No Git push or remote deployment was performed. Existing unrelated backend changes were preserved.
