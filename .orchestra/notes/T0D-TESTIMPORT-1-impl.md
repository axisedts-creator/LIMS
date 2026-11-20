# T0D-TESTIMPORT-1 impl (writer)
- New: features/catalog/server/testImport.server.ts (six typed calls, 5 MB + name + mode re-check, If-Match, Idempotency-Key), server/testImportActions.ts (actions keep problem `detail`), components/TestImportScreen.tsx (4 steps, errors table, dialog, result, history).
- Changed: app/(staff)/catalog/imports/page.tsx (?view=tests; 403 -> CatalogForbidden, 500 throws), components/ImportsScreen.tsx ("Import tests" link for catalog.test.manage). No route, no nav entry added.
- [CONV] downloads (template, errors file) go through proxyDownload inside a server action, come back base64, then an anchor download: no new route (rs-c2). [CONV] upload = kit FileUpload uploadFile, one Idempotency-Key per pick, 5xx retried same key, 4xx retryable:false with server detail.
- [CONV] Commit enabled only when batch.status=validated, 0 errors, batch.mode = current mode, not uploading/committed; one key per batch; dialog closes on confirm (double click = one POST). Density from the shell wrapper (T0D-DENSITY-1).
- Round 2 (after ruling, no code change): testimport1 70/70, testmgmt1 141/141, rs-c2 74/74, web-t35 95/96 then flow test 1/1 on rerun (first run 30 s timeout under load).
- Round 3 (after testfix1 revised per ruling, no code change): testimport1 70/70, testfix1 122/122, web-t35 96/96, testmgmt1 141/141, rs-c2 74/74. Open: none.
