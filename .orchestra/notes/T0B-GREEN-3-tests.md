# T0B-GREEN-3 tests (ruling applied)
Files: db/tests/engagement/T0B-13.C16_schema.test.sql, db/tests/engagement/T-SEC1_table_probes.test.sql (STALE updates cite migration 20261117130000, T0C-CONTENT-1, LD-313/LD-325).
Changed per ruling: tables 43->45 (+portal_content, profile_image in rt and expected), indexes 51->52, audit triggers 24->26, FK schema list +identity. Nothing deleted; :91 and :123 unchanged.
Probe rows: db/tests/fixtures/probe-rows/engagement.sql already has portal_content and profile_image rows (not edited by tester); no CR needed.
Run: T0B-GREEN-3-verify.cmd in this folder (run-suites.sh on core, definers, engagement, identity).
NOT RUN: bash fork fails on this PC (Windows error 1455 / 0xC000012D, LD-367), so no suite result yet.
