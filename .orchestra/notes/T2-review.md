APPROVE

Re-review after fe2a8e8/7b00848. Prior items 1–2 resolved:
1. settings.ranges.ts: SETTING_FORMATS now covers every 05-SCHEMA §4.6 regex/length/count rule (numbering_prefix, barcode_prefix, accession_prefix_*, sms_sender_id, accent_color, website, display_name, contact_email, receipt_footer_note, address_lines, phones) -> `common.field_invalid` at `/<field>`; abbreviated_invoice_limit_paisa (NULL or safe int >=0) -> `identity.setting_out_of_range`. Nullable cols accept null. *_pattern routing deferred to T16, recorded in T2-impl.md.
2. settings.ranges.test.ts: boundary +-1 for each length/count, valid/invalid per regex (incl. trailing newline, non-ASCII), NULL handling, mixed-code patch.
Re-checked: names/codes verbatim; pure functions, no logs/PHI/secrets; only owned paths + own notes. RLS/idempotency/rate tier N/A (no DB/HTTP).
Ran T2 tests: 4 files, 241/241 pass (vitest 5.1.0).
