TESTS_WRONG — `services/api/src/modules/reporting/__tests__/manifest.test.ts` IMPLEMENTED set (lines 72-83) must include the six portal operationIds implemented by C6-T20.
Change: add, with comment `// LEAD-VISIBLE TESTER EDIT (C6-T20): P1-P6 leave the 501 list; covered by the C6-T20 portal handler tests.`, the entries
`'createPortalOtpChallenge', 'verifyPortalOtp', 'getPortalReport', 'downloadPortalReportPdf', 'requestPortalLinkReissue', 'endPortalSession'`.
Do not add P7/PP1/PP2 or previewReportTemplate (T5); everything else still must answer 501. No implementation change.
Reasons:
1. spec/chunks/C6-reporting-delivery/06-IMPLEMENTATION-PLAN.md:32 — C6-T20 owns P1-P6 (portal auth + API); those ops are no longer stubs once T20 merged (e9cd88e).
2. spec/chunks/C6-reporting-delivery/02-TRD.md:634 — §6.6 portal endpoints use security `portalSession`; :646-651 give P1-P6 operationIds and require `reporting.link_invalid` / `reporting.otp_required` on missing/invalid credentials, so failing closed (auth error) without a portal ctx is correct and a 501 would contradict the spec.
3. Test's own rule (manifest.test.ts:69-70) says each later task adds its operationIds to IMPLEMENTED; C6-T20 was not added. Failure is not caused by C6-T18 (T1-T4, T6 already listed at :80-81).
