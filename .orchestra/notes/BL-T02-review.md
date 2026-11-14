APPROVE
Reviewed 46dd1d8..HEAD (BL-T02). vitest billing/domain: 8 files, 242/242 pass; tsc --noEmit: no billing errors.
- Names verbatim: statuses match 05-SCHEMA ck constraints and 03-APP-FLOW §1.5–1.8; CBMS transitions/outcomes match 05-SCHEMA:685-686 and TRD:546; series keys INV / INV:<branch> / CN / RC (TRD §12); tokens {fy},{fyl},{prefix},{branch},{seq:N} from 03-IC §9.3.
- Error codes all registered in contracts/errors.yaml (common.validation_failed, common.date_out_of_range, catalog.tax_config_missing, billing.counter_busy + detail fiscal_year_rollover, billing.invoice_already_cancelled, billing.cancel_reason_required, billing.numbering_pattern_invalid).
- FY: TRD §12 rule, 2025-07-16 23:59/2025-07-17 00:00 NPT golden, 2000–2099 B.S. sweep (D13) per arbiter ruling.
- Tax: US-BL-14.1 (1000.00 -> 130.00), .2 exempt column, .3 no guessed rate, .4 >=50 goldens incl. bill discount, surcharge, exempt mix; credit split rounding covered.
- Pure domain: no DB/RLS/permissions/idempotency/rate-tier surface in scope; no logging, no PHI, no secrets; only owned paths + role notes.
Non-blocking note: numberFormat rejects {yy}/{centre} (listed generically in 03-IC §9.3); spec defines no fiscal-number grammar beyond {branch}, so not a defect now — revisit if C2 pattern validation needs them.
