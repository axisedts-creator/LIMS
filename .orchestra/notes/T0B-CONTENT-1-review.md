APPROVE

Scope note: `af6266493..HEAD` holds only debugger notes and logs. The T0B-CONTENT-1 code itself came in earlier commits on this lane (292a427ed tests; 11c913571 and 457e45127 impl; c1b3b8677 test per the arbiter ruling d77138442), so the review covers those files against T0C-CONTENT-1 in engagement.yaml and LD-313, LD-325 and LD-368.

Checked:
- Names: the 9 operationIds, the permissions engagement.content.read, engagement.content.manage and engagement.self.read (permissions.yaml:191,265-266) and the error codes (all in errors.yaml) are copied verbatim. Nothing invented.
- Tenant isolation: every statement binds tenant_id=$1 on top of RLS (the migration is not in this task). Asset ownership is checked against identity.branding_assets with the same tenant, active, not quarantined, not a signature, PNG or JPEG. A foreign id gets the same answer as an unknown one. The `::uuid[]` cast is used in applyOrder.
- Permissions: assertRole runs before any query, and the handler fails closed if the port is missing. listMyPortalContent refuses a non-patient actor. Idempotency and the rate tier are left to the pipeline (x-idempotency required on create). The If-Match optimistic lock is applied on update and deactivate.
- Markdown: one shared helper (safeMarkdown.ts). It validates on write and re-validates on the public read, so a dirty stored body is dropped. renderMarkdown escapes everything outside the whitelist, links are https only, and the scan is linear. The contract says the public body is Markdown (render with HTML off), so returning the Markdown text is correct.
- Public read: active items inside the date window only, ordered by kind then sort_order, public keys only, no personal data.
- Cache: `public, max-age=60` plus `Vary: Authorization`. This follows done_when (3) over the contract's no-store. The conflict was already raised to the lead in T0B-CONTENT-1-tests.md.
- Audit: the row audit triggers in migration 20261117130000 (lines 112-113) cover every write, and the tests assert the INSERT and UPDATE audit rows.
- Logs and secrets: no logging of bodies, no secrets.
- Paths: engagement module only, plus core/__tests__/pending-operations.test.ts, which the arbiter ruled on (TESTS_WRONG, LD-325 a). The 9 ids are gone from pendingOperations (LD-368).
- Tests: admin, images, markdown, public and static cover every operation, tenant isolation, the date window, injection cases, attachment ownership, races and permissions. Per the round 5 and 6 debug notes, every content test passed. The one failure is real-modules-boot timing out under PC load, and it passes when run alone.

Non-blocking (for the lead, not a defect of this task): the date window uses the database current_date, not the tenant's local date. That matters only if the DB timezone is not the tenant's.
