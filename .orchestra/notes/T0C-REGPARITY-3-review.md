APPROVE

Scope note: the briefed range 65e629e4b..HEAD is empty (HEAD == 65e629e4b, the merge of main that brings in T0C-LINTFIX-1). Reviewed the task commits already in HEAD: c65c4fe08 (tester), d39615e56 (writer), 46d75aa09 (debugger notes only).

- contracts/openapi/frontdesk.yaml: RegistrationNumberPreview matches LD-331 option B exactly: next_receipt_no type string, minLength 0, maxLength 64, required, empty string when unavailable (no nullable, no type array, X10 clean); next_receipt_no_label required string 1..64, "assigned when saved"; additionalProperties false kept; example 2083/84-000077 + label; RC- example gone. Descriptions cite LD-323/LD-331.
- Generated outputs only (api-client-ts frontdesk.ts, server/operations.ts, fakes MSW handler); staleFiles() empty. 5 files total, within cap. No service, web, migration, permission, other-schema or lint-rule change. Operation, x-permission (frontdesk.registration.create) unchanged.
- No RLS/idempotency/rate tier/error-code surface touched (contract-only GET schema). No PHI, no secrets; data synthetic.
- Tests cover done_when: success body and port-failure body (empty string + label) validated with Ajv; null/absent/over-length rejected; X10 repo-wide; example shape; generated types and handler pinned.
- Ran: `npx vitest run regparity3 regparity2 lint-openapi` = 290/290 pass (lintRepo of root clean now that LINTFIX-1 is merged); `oasdiff.test.ts` = 21 pass, 3 skipped (pre-existing skips).
