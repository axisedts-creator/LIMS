APPROVE

Re-review of cf16e8211..HEAD (fd584a6f4, f6fad0925, da9bb7cb6): the round 1 review, the committed probe fixture rows and an impl notes line.

Round 1 item 1 (uncommitted probe fixture rows) is fixed:
- f6fad0925 commits db/tests/fixtures/probe-rows/partners.sql (+12: sales_designation, sales_representative, party_sales_assignment, service_area) and db/tests/fixtures/probe-rows/homecollection.sql (+3: collector_flags). Each table has a tenant A and a tenant B row, and the FKs are consistent within each tenant (representative f1 -> designation f1, service_area centre 21/23).
- `node db/tools/gen-isolation-probes.ts --check` on the clean committed tree: "ok (455 probe files, 19 fixture files current)". A full regeneration (run-suites.sh) leaves `git status` clean.
- `bash db/tests/run-suites.sh` on the 5 new isolation probes (partners.sales_designation, sales_representative, party_sales_assignment, service_area, homecollection.collector_flags): 0 not ok, no psql failure.

No product, contract, migration or permission file changed in this range, so the round 1 "checked and fine" findings still hold (names verbatim, RLS ENABLE+FORCE, DB rules, permissions, pendingOperations, no PHI or secrets, field map, offline classification, founder steps). The impl notes line is accurate. Only test fixtures and notes changed, all on owned paths.
