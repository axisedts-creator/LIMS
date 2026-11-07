# C6-T11 impl (writer)
Files: new `handlers/narrative-image.handlers.ts`, `service/narrative-image.service.ts`, `repository/narrative-image.repo.ts`; `index.ts` wires N6/N7; `outsourced.service.ts` safeName(+fallback); worker `tasks/process_input_file.ts` handles kind narrative_image.
N6: caption/id validated -> narrative looked up (tenant, BOLA 404) BEFORE any byte stored -> `ctx.uploads.accept` allow png+jpeg, images.reencode+stripMetadata, scan required -> insert row (pending_scan, caption) -> enqueue `reporting.process_input_file`. Response `{image_id,state}`.
N7: kind=narrative_image + state ready + sanitized path + detected_mime png/jpeg, else 404 / reporting.input_file_not_ready; same security headers as O5; access log report.view / narrative_image.
Worker: re-scan, then re-encode again with core reencodePng (no PDF sandbox), publish `{tenant}/narrative-images/{yyyy}/{mm}/{id}.png` ifAbsent (byte-identical retry ok), record sha/detected_mime/width/height.
[CONV] worker image rejection code = common.upload_quarantined (N6 list); infected metric reuses lims_reporting_sandbox_rejections_total{reason=infected}; N6 infected keeps common.upload_quarantined (not remapped).
Open: dispute resolved (ruling TESTS_WRONG, tests revised; no code change needed). JPEG refused 422 until core JPEG decoder (CR T0D-17). P-10 narrative.write on N7, signed-narrative + 12-image cap -> C6-T17.
Checks: verify.cmd api 123/123, worker 25/25; full reporting api 618/618, worker 65/65; tsc api: no errors in reporting (pre-existing shared-ts TS5097 only); worker has no tsconfig.
