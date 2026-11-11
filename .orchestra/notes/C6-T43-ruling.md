TESTS_WRONG — the assertion at tests/portal-e2e/C6-T43.dues.e2e.ts:46 (land on /r/{token}/payments/pr-1) is correct; the fixture tests/portal-e2e/stub-reporting-dues.mjs is incomplete and contradicts the spec, so the TESTER must fix the stub, not the test or the implementation.
Change: in stub-reporting-dues.mjs add, next to the PP1 handler (l.50), a PP2 handler:
`if (p === '/portal/payment-requests/pr-1' && req.method === 'GET') { if (!need()) return; return send(200, { id: 'pr-1', status: 'queued', gateway: 'esewa', review: false }, { 'cache-control': 'no-store' }); }`
Leave every assertion in C6-T43.dues.e2e.ts unchanged; do not weaken the T42 "PP2 404 -> leave the payments page" rule.
Reasons:
- spec/chunks/C6-reporting-delivery/02-TRD.md:654 — PP2 `GET /portal/payment-requests/{id}` with a `session` credential returns `200 PortalPaymentRequest` with `Cache-Control: no-store`; `common.not_found` is only for another link's request (RLS). The stub answers 404 for the request the same session just created (PP1, stub l.50), which a conforming API never does.
- 02-TRD.md:553 — PortalPaymentRequest shape `id, status (queued|…), gateway, review, …`; the proposed body matches it (no action_url, since status is queued).
- 02-TRD.md:215 — the /r/[token]/payments/[id] page shows the payment status, so it must call PP2; 02-TRD.md:665 (step 3) — PP2 only reads the row.
- 02-TRD.md:656 — PP2 needs `reporting.portal.view`, the same as PP1/P7, so a dues session may call it. No spec text stops a dues session reading its own payment request.
- The writer's PP1 -> 303 /payments/pr-1 path works (dispute l.2); the only failure is the missing fixture route.
