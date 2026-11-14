TESTS_WRONG — the 8 failing crossTenant probes fail inside the probe harness (probe.kit.ts + sample builder), before any tenant-isolation check runs; the implementation is right and must not change (binding LD-105, 2026-11-11).
- Spec only requires tenant B ids to give `404 common.not_found` with no side effects (07-SECURITY.md:94 A11) and centre scoping to hold (07-SECURITY.md:15 REQ-SEC-017). Anonymisation is governed by 07-SECURITY.md:46 REQ-SEC-139. The guards that now fire are these same fail-closed guards, so removing them would break the spec.
- TESTER changes ONLY services/api/src/modules/billing/__tests__/probes/probe.kit.ts and its sample builder:
  1. probe.kit.ts:120 IdentityPort stub: add `readBrandingAsset` (printInvoice, printCreditNote currently get common.internal from invoice.service.ts:293).
  2. `ctxFor`: add `uploads.accept` (uploadTrf, getTrfAttachment, getTrfAttachmentContent currently get common.internal from trf.service.ts:35).
  3. anonymisePatient: use tenant A's actor with `centreScope.all === true` so the call reaches the tenant lookup and still expects not_found for tenant B's id. Do NOT add auth.forbidden to the allowed codes.
  4. updatePatient: send a valid one-field body so the lookup runs before "nothing to change" (patient.service.ts:268). searchPatients zero-rows: send a valid query of ≥3 chars (probe.kit.ts:76 currently emits 'x'; patient.service.ts:146).
- Keep every existing crossTenant assertion and both own-tenant control cases unchanged. No other test file changes, and no implementation file changes (the round-9 createBillingExport fix stays).
- If any probe still fails after this, write a new dispute naming the exact probe and code path.
