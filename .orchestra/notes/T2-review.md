CHANGES

Checked: names/codes verbatim (auth.password_policy_violation, auth.password_breached, identity.setting_out_of_range, common.validation_failed, common.field_invalid); numbering grammar vs 03-APP-FLOW §6.1 + C5 02-TRD §4.2; support allowlist vs 02-TRD §7.4; AC-B2.1/B2.2; 72-byte Devanagari boundary. Pure functions, no logs, no secrets, only owned paths (+ own notes). RLS/idempotency/rate tier: N/A (no DB/HTTP in T2). Ran T2 tests: 4 files, 203/203 pass.

1. services/api/src/modules/identity/domain/settings.ranges.ts:6-23 — done_when is "100% of rules in 05-SCHEMA §4.6", but only the integer ranges and enums are implemented. Missing §4.6 rules (05-SCHEMA.md:197-228):
   - numbering_prefix `^[A-Z0-9]{0,8}$`; barcode_prefix and accession_prefix_histology/cytology/ihc/molecular `^[A-Z0-9]{0,4}$`; sms_sender_id `^[A-Za-z0-9]{1,11}$`; accent_color `^#[0-9A-Fa-f]{6}$`; website ≤200 and `^https://`;
   - display_name 1–120; contact_email ≤254; receipt_footer_note ≤200; address_lines ≤4 items, each ≤120; phones ≤3 items, each ≤40;
   - abbreviated_invoice_limit_paisa ≥0 (integer, NULL allowed).
   Fix: add a pattern/length table next to SETTING_RANGES and check it in validateSettingsPatch. abbreviated_invoice_limit_paisa (a range) → `identity.setting_out_of_range` at `/<field>`. Format/length failures → `common.field_invalid` at `/<field>` (02-TRD §5.6: "400 validation (pattern errors at JSON pointer)"). The return type must carry both codes. Also route the *_pattern columns to validateNumberingPattern from the same entry point, or record in T2-impl.md that T16 must do it.
2. services/api/src/modules/identity/domain/__tests__/settings.ranges.test.ts — add tests for every rule in item 1: boundary ±1 for each length/count limit, one valid and one invalid value per regex, and NULL handling for the nullable columns (barcode_prefix, sms_sender_id, contact_email, website, receipt_footer_note, accent_color, abbreviated_invoice_limit_paisa).
