APPROVE

Reviewed `git diff 05c5ce3..HEAD` (WEB-T01).
- nav.manifest.ts matches C7 04-UI-UX §1 verbatim (ids, routeIds, permissions, group, order, chords); routeIds/permissions match contracts/routes.yaml (CR-C7-003). Labels are message keys per C0 NavEntry type (`label: message key`) — OK.
- loading.tsx / error.tsx at segment root use kit `LoadingSkeleton variant="page"` / `ErrorState {title, body, requestId, onRetry}` with valid props; error.tsx is `'use client'`, shows only `digest`, never message/stack (no leak).
- Help files: copy traceable to 04-UI-UX SCR-01/03/05/09/11 and shortcut table; link routeIds exist.
- Only owned paths (features/instruments/*, app/(staff)/instruments/*, own notes). No secrets, no PHI, no DB/API surface (RLS/idempotency/rate tier N/A).
- Ran `node --test src/features/instruments/__tests__/web-t01.test.ts`: 14/14 pass, incl. build-nav CLI exit 0 (done_when) and drift-rejection guard. Working tree clean after run (generated.ts already up to date).
- Not verified: `next build`, full tsc (impl notes pre-existing C0 errors in app/layout.tsx), nav label i18n catalogue merge (C0 open point).
