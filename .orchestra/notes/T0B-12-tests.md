# T0B-12 tests (tester, LD-54 + LD-55)
- `tests/db/T0B-12.storage-buckets.test.mjs` (unchanged, incl. both GATE tests): static checks, no SQL on schema storage, script/README static.
- NEW `tests/db/T0B-12.storage-provisioning.test.mjs` (node, 127.0.0.1 stub Storage server, spawns the script): unset/empty URL, key file missing/empty/trimmed, base path prefix, both auth headers, create absent (private), flip public, idempotent re-run, untouched private/foreign buckets, pagination >100 (offsets 0/100/200), 4xx/5xx on list/PUT/POST exit non-zero, POST-fail re-list, no credential/URL/body in output.
- `db/tests/storage/T0B-12_storage.test.sql` (pgTAP): post-provisioning smoke; NOT run (LD-54).
- Fails now (script still stubbed, exits 2): 16 of 39 new tests; passing "exits non-zero" ones pass for the wrong reason until the transport is wired. GATE fails until SP-4.md gets the LD-55 section.
- Run: `.orchestra\notes\T0B-12-verify.cmd` (both node files). Writer: wire HTTP in create-storage-buckets.mjs; output lines `<bucket> created|ok|flipped`.
