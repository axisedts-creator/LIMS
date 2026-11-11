TESTS_WRONG — uploads.handlers.test.ts assumes ctx.uploads.accept runs before identity/centre-scope checks; the spec does not require that order and its harness ctx cannot reach accept().
- Spec for F20 uploadTrf (02-TRD.md:213, :42) names permission `frontdesk.trf.upload`, `ctx.uploads.accept` options and the 413/415 codes; it states no ordering of accept vs. role/scope/order checks.
- 07-SECURITY.md:15 (REQ-SEC-017) requires centre scoping on TRFs; 07-SECURITY.md:94 (A11) requires foreign ids => `404 common.not_found`, no side effects. accept() stores bytes, so checking scope first (trf.service.ts:78-93) is consistent with spec; the test's ordering assumption (uploads.handlers.test.ts:4-5) is not a spec requirement.
- 07-SECURITY.md:35, :150 (§6.6) define only the hostile-file outcomes; those assertions (uploads.handlers.test.ts:44-75) stay unchanged.
Change in the test (upload() helper, uploads.handlers.test.ts:22-32) ONLY:
1. Pass `ports` with an IdentityPort whose `assertRole` resolves and whose `getActor` returns `{ displayName: 'Synthetic Tester', centreScope: { centreIds: [CENTRE_A1] } }` (other ports may stay notFound proxies; body has no order_id so no order lookup runs).
2. Add `download: { stream: async () => undefined }` and `storage.delete: async () => undefined` to the ctx (trf.service.ts:35 requires them), keeping the recording `storage.put`.
3. Give `spyTx` / ctx what the 201 path needs (insert/enqueue) only if a clean-path case reaches it; do not alter expected codes or the `stored` checks.
4. Update the header comment (lines 4-5) to drop the accept-first ordering claim. Implementation unchanged.
