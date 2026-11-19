Title: CR-C0-PRICETOOLS-1: a catalog upload bucket and a 422 code for refused price changes
From chunk: C0 (T0B-PRICETOOLS-1, LD-321)            To owner: C0-0B (core storage, errors registry)
Type: api | shared-lib
Blocking? no (the task ships with the two [CONV] stopgaps below)

Problem 1 (done_when 6 "the uploaded file is stored through the existing upload path"): core/storage BUCKET_OWNERS has no bucket owned by `catalog`, so ctx.uploads.accept
refuses every catalog write (assertOwned). T0B-TESTIMPORT-1 hit the same gap and stores only the normalized JSON.
Stopgap [CONV]: the dry run stores the validated rows plus a seal sha256(file_sha256 | rows) in price_list_import_batch.summary; file_ref = "sha256:<hex>" (content address, not an object key);
commit re-computes the seal and refuses (409 catalog.import_not_committable) when the hash or the rows changed. The workbook bytes are not kept.
Proposed change: add `'catalog-imports': 'catalog'` to BucketName / BUCKET_OWNERS (core/storage/index.ts, 03-IC §13.4); then dryRunPriceListImport stores the file under
`{tenant}/price-imports/{batch_id}.xlsx` through ctx.uploads.accept (scan 'required') and file_ref becomes that object path; commit reads it back and re-hashes it.

Problem 2 (contract bulkUpdatePriceListDraft / copyPriceList: "checked by the service, 422", "a result below 0 refuses the whole request with 422"): contracts/errors.yaml registers no
422 code for that refusal; an unregistered code renders as 500.
Stopgap [CONV]: 422 catalog.formula_invalid with a fixed detail ("percent needs percent_bp", "a resulting price would be below 0 or above 9999999.99 rupees ...").
Proposed change: `- { code: catalog.price_change_invalid, http: 422, owner: C3, title: "Price change cannot be applied", meaning: "Bulk update / copy: missing parameter or a resulting price outside 0..999999999 paisa" }`
and add it to x-error-codes of bulkUpdatePriceListDraft and copyPriceList.

Backward compatible? yes (additive bucket, additive error code).
Tenant/security impact: bucket is tenant-pathed like the others (assertTenantPath); no PHI (price lists only). REQ-SEC-083..085 scan path reused.
Alternatives considered: storing the bytes in a bytea column (rejected: 5 MB rows in an audited table); reusing catalog.no_price (misleading text).
Tests that will prove it: pricetools/dryrun.test.ts file_ref checks + a storage round trip; bulk.test.ts err422 with the new code.
