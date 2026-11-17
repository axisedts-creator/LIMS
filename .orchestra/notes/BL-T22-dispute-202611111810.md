# BL-T22 dispute (debugger, round 9): TESTS_WRONG, 8 of 9 verify failures

After BL-T15 landed, 9 crossTenant probes fail. Impl fix for 1 (createBillingExport). The other 8 are probe-harness gaps, not C4 defects. No test edited.

| probe | actual | cause in probe.kit.ts / sample builder |
|---|---|---|
| printInvoice, printCreditNote | common.internal (invoice.service.ts:293) | `tenantAPorts().IdentityPort` has no `readBrandingAsset` (fail-closed dependency guard, A6) |
| uploadTrf, getTrfAttachment, getTrfAttachmentContent | common.internal (trf.service.ts:35 `trfCtx`) | `ctxFor` has no `uploads.accept` (it has storage.delete and download.stream only; LD-98 (1) list omitted it) |
| anonymisePatient | auth.forbidden (patient.service.ts:341) | actor scope is `centreIds:[CENTRE_A1]`; handler fails closed unless `centreScope.all === true` (CR FD-T15, REQ-SEC-139 P-12 c); probe allows only not_found |
| updatePatient | common.validation_failed (patient.service.ts:268) | sample builder emits `{}` (no required fields) so "nothing to change" fires before the lookup |
| searchPatients zero-rows | common.validation_failed | sample builder emits query `'x'`; 07-SECURITY/US-FD-01.3 min 3 chars (patient.service.ts:146). The control case in the same file already notes this |

Needed test changes (TESTER only): add `readBrandingAsset` to the IdentityPort stub and `uploads.accept` to `ctxFor`; give anonymisePatient a `centreScope.all` actor or allow `auth.forbidden` for it; give updatePatient a one-field body and searchPatients a valid query in the zero-rows case.
Impl cannot satisfy these without removing fail-closed guards (07-SECURITY A6/A11, REQ-SEC-017/139). Not done.
