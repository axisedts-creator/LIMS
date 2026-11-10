Title: CR-C8-NEW: @lims/ui RadioGroup needs per-option `isDisabled`
From chunk: C8            To owner: C0-0A (ui kit)
Type: ui-kit
Blocking? yes (AN-T17 ExportDialog: test "PDF is disabled with the 'not available yet' hint while the flag is off" cannot pass)
Problem: 04-UI-UX §6 requires a `RadioGroup` [Excel, CSV, PDF] with PDF disabled until LIMS_ANALYTICS_PDF_ENABLED. packages/ui RadioGroup only supports group-level `isDisabled`; `options` is `{value,label}` only. Group-level disable would also lock Excel/CSV. Hand-rolled radios would be a look-alike of a kit component (done_when / 08 R22).
Proposed change (exact): `options: readonly { value: V; label: string; isDisabled?: boolean }[]`; in RadioGroup.tsx pass `{...(o.isDisabled ? { isDisabled: true } : {})}` to `<Radio>`.
Backward compatible? yes (optional field).
Tenant/security impact: none.
Alternatives considered: native <input type=radio> in ExportDialog (rejected: not kit); omit PDF radio (rejected: test + spec require it visible, disabled).
Tests that will prove it: an-t17.export "PDF is disabled ..." + "PDF is selectable when pdfEnabled".
