# T2 impl (writer)
Files: services/api/src/modules/identity/domain/{password-policy,numbering-pattern,settings.ranges,permission-set}.ts. Tests: 4 files, 241/241 pass (vitest 5.1.0).
[CONV] numbering max length checked statically with MIN token widths: {yy} 2, {fy} 6 (`082/83`), {fyl} 7 (`2082/83`) per 03-IC §9.3; {prefix} 0, {branch}/{centre} 1. Renderer must re-check the real rendered length. Barcode also rejects {branch}/{centre}/{fy}/{fyl} (C5 02-TRD §4.2).
[CONV] permission-set registry param defaults to DEFAULT_REGISTRY from contracts/ports/generated/permissions.ts; fixed actor / support (02-TRD §7.4) lists from generated constants. Unknown scope/actor/variant -> [].
settings.ranges: int ranges + enums + abbreviated_invoice_limit_paisa (NULL or safe int ≥0) -> identity.setting_out_of_range; §4.6 regex/length/count rules (SETTING_FORMATS) -> common.field_invalid; nullable cols accept null.
[CONV] lengths counted in UTF-16 code units (JS string length); contact_email checked for length only (§4.6 lists no format).
Open: *_pattern columns NOT routed from validateSettingsPatch — T16 must call validateNumberingPattern. pending_* / billing_live_on / ird_pan / legal_name_snapshot left to T16. tsc: only pre-existing TS5097 in packages/shared-ts/src/bsdate (not C2). Full DB-backed api suite not run.
