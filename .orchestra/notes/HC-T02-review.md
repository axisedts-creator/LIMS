APPROVE

HC-T02 review (diff d449a8c5..HEAD).
- State tables match 03-APP-FLOW §1.1 V1–V11, §1.2 C1–C4, §1.3 exactly; full from×to matrix tested (allowed + every forbidden pair). Named codes (visit_closed, mutation_superseded, collection_not_held, common.validation_failed, common.version_conflict) all exist in contracts/errors.yaml. [CONV] reuse for unnamed forbidden pairs is documented, not invented.
- mutation.ts payload checks match contracts/openapi/homecollection.yaml Mutation* payloads + Gps/PaymentAmount and _common Uuid/Uuidv7/Code/DecimalString (closed objects; `__proto__` key rejected).
- clock.ts follows TRD §7.5 steps 1–4; skew = device_wall_time − corrected (§7.5 metric line). cursor.ts matches TRD §6.2 step 3; decode never throws.
- Pure, no IO/logging/secrets/PHI; RLS/permissions/rate tier/idempotency N/A for a domain-only task. Paths: domain/* + module __tests__ only.
- Ran: vitest domain suite 6 files / 204 pass; `tsc --noEmit` 0 homecollection errors. eslint not run (not installed in services/api).
