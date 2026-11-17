APPROVE

# C6-T11 review (reviewer)
Scope: `git diff abb3122..HEAD`. All paths owned by C6 (modules/reporting, worker jobs/reporting, own notes).
- Names verbatim: N6 `uploadNarrativeImage` / N7 `getNarrativeImageContent` (02-TRD §6.4); input_files columns (narrative_report_id, kind 'narrative_image', caption, image_width/height, detected_mime, sanitized_*) match 05-SCHEMA §6; object key `{tenant}/narrative-images/{yyyy}/{mm}/{id}.png` matches §12; access log `report.view` / `narrative_image` matches the audit table; error codes `common.unsupported_media_type`, `common.payload_too_large`, `common.upload_quarantined`, `reporting.input_file_not_ready` as in 02-TRD N6/N7.
- Tenant isolation: no new tables (no RLS change needed); every SQL has explicit `tenant_id = $1` plus the caller re-checks; BOLA lookup happens before any bytes are stored; tenant and actor come from ctx only.
- Upload pipeline: `ctx.uploads.accept` allows png+jpeg, re-encode + stripMetadata, scan required, 15 MB cap; SVG -> 415 (test :80-95). The worker re-scans and re-encodes again (40 MP = core default), never calls the PDF sandbox, fails closed when the scanner is down, and the publish step is idempotent.
- N7 headers: attachment, nosniff, no-store, CSP sandbox; serves only the sanitised object.
- Logs hold ids only, no PHI. No secrets.
- Checks run: api reporting 618/618 pass, worker reporting 65/65 pass.
- Deferred per plan row C6-T17 (not a defect here): N7 P-10 conditional `reporting.narrative.write`, the signed-narrative upload lock, the 12-image cap. JPEG is advertised but refused 422 until core has a JPEG decoder (CR T0D-17). Lead should track both.
