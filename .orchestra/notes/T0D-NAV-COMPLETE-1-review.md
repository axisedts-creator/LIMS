APPROVE

Re-review of `git diff 4abcb6288..HEAD` (25 files) after review fixes 17408b2f1 (tester) and 366b409cd (writer).

Prior items:
1. Fixed. apps/web/src/core/i18n/messages.ts:22-57 adds 35 English strings next to `core.nav.*`, one per new label key; C15 s1 and C16 s1.3 strings match the spec tables verbatim. Existing keys untouched.
2. Fixed. rs-c4.baseline.json: only the `logic` hashes of frontdesk/billing nav.manifest.ts and the frontdesk_feature/billing_feature permission lists moved (new codes frontdesk.order.read, billing.credit_party.read, billing.invoice.read; the signature scraper also picks up the `frontdesk.nav.*` label keys, which is harmless). Nothing else in the baseline changed.

Re-verified: manifest path/permission/group/order match C4 s3/s6/s7/s8, C3 SCR-06, C5 s1, C15 s1, C16 s1.3; 19 additive non-parameterised staff_web rows in routes.yaml, owners and permissions correct; no screen, operation, permission or role pack change; no secrets or PHI; no DB or RLS surface.

Checks run by reviewer:
- nav-complete config: 8 files, 76/76 pass.
- rs-c4 config: 4 files, 36/36 pass.
- r04.groups: pass.
- rs-c2.static "same route files": FAILS on app/(auth)/auth/page.tsx and app/(auth)/layout.tsx. Those files are not touched by this task, so the failure predates it and is not a defect here.

For the lead (not defects): pnpm -s verify was already red before this task (api/web typecheck, plus the rs-c2 failure above). Each needs its own task. The Front desk settings page is missing (CR T0D-NAV-COMPLETE-1.1), so the administrator cannot reach discount limits yet. Founder report: T0D-NAV-COMPLETE-1-admin-hidden.md.
