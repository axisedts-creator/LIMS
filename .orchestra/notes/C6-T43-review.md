APPROVE
Scope 948e1dc4..HEAD: one code line, tests/portal-e2e/stub-reporting-dues.mjs:51 (PP2 GET handler). It matches the arbiter ruling verbatim and 02-TRD:553/654 (200 PortalPaymentRequest, Cache-Control: no-store, behind need() session check). No assertion in C6-T43.dues.e2e.ts changed or weakened, and the T42 PP2-404 rule is untouched. Everything else is notes and test-results artifacts.
LD-96 spot check (outside range): portal.resolver.ts:30 is the exact LD-96 line. purpose comes from the DEFINER row (the migration returns it), never from the credential, and it carries the LD-96/A37 comment.
No names invented, no PHI or secrets, no auth/RLS/policy changes in range.
Non-blocking (tester-owned, not in this diff): debugger rounds 1-2 found Playwright flakes at C6-T43.dues.e2e.ts:14, where waitForLoadState('networkidle') never settles under next dev on Windows. Suggest a web-first wait (expect(getByRole('button',{name:'Send me a code'})).toBeVisible()) so verify is deterministic.
