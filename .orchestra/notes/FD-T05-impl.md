# FD-T05 impl (Quote F8)
- Files: service/registration.service.ts (`quote`), handlers/quoteRegistration.ts, handlers/index.ts (wired), service/patient.service.ts (only `export` added to `bad`, `isObj`).
- Result (after ruling FD-T05-ruling.md, no impl change): FD-T05.pg.sh 64/64; quote.static 8/8. tsc: 0 errors in frontdesk (21 elsewhere, pre-existing). boot.test nav failure pre-existing (not FD-T05).
- [CONV] fiscal_year_bs = shared-ts fiscalYearBs(tenant-local date).long (no port gives it). Unknown request keys ignored (core schema rejects them). One line per orderable (duplicate -> 400 /items/N/orderable_id); line_ref = `<orderableId>:<priority>`.
- [CONV] settings row missing -> defaults 0/0/10000. exceeds_limit (>absolute max, or discount > line/gross) -> 422 before/after computeQuote; credit state via assertCreditAllowed caught by `.code` (port LimsError class differs from core's).
- Open: reason_code not checked against coded set frontdesk.discount_reasons (pipeline x-coded-set); static test slices registration.service.ts from `quote` to EOF, so later tasks must add INSERT/UPDATE code above `quote` or it fails; no pending.json exists in this tree.
