APPROVE
Re-review of `git diff 486602609dbb..HEAD` (BL-T15) after review round 1. Ran BL-T15-verify.cmd suites: api 83 pass / 6 skipped (live, no DB), worker 49 pass.
Round-1 items:
1. Fixed. Object key from job `created_at`; ifAbsent clash reads back via StorageAdapter.read (core/storage `read` exists), XML must hash-equal else rethrow, PDF reuses stored bytes. Worker test covers fail-after-put then later-month retry -> ready, one object.
2. Fixed (fail closed). export_render: `invoice_documents` -> Permanent `common.feature_disabled`; no sales-register mapping left. B28 still accepts the kind per TRD enum (test:100); resolution tracked in `.orchestra/cr/BL-T15.md` (CR-C4-BL15 B).
3. Fixed. `cancelled_by` not added; CR-C4-BL15 A filed per template.
4. Fixed. B26 and credit_notes export ORDER BY fiscal_year_bs, credit_note_seq, id; keyset (fy, seq, id) with `f` validated (FY regex), missing `f`/non-integer `k` -> `common.invalid_cursor`; repo ordering test added.
Still OK from round 1: tenant_id + `::uuid[]`, RLS untouched, caps/error codes, access_log create/download, no URL/PHI in logs, owned paths only.
Not verified: real SQL (no LIMS_TEST_DATABASE_URL), real RenderPort, real xmllint XSD validation.
