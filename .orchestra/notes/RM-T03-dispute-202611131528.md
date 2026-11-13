# RM-T03 dispute (writer): spec/data mismatch, not fixable by the writer

Failing: matrix-replay.test.ts > elabcorp_default > "feature Menu / Pathology Result: ticked-role count matches the sheet" (317/318 pass).
Error: `Menu / Pathology Result: sheet says 3 roles ticked, more hold its feature-only codes: expected 4 to be less than or equal to 3`.

Cause: 11-ROLE-MATRIX is self-inconsistent.
- §5.1 says 3 roles tick Pathology Result. §3.1 overlay text gives critical values only to the Pathologists; the Sr/Senior Lab User roles get "entry + verify + QC + worksheet", and Laboratory Lab User gets "entry only".
- The per-role listings in §6 (and 11-ROLE-MATRIX.data.yaml, binding under LD-141) give `lab.critical_value.read` and `lab.critical_value.log_notification` to corp_laboratory_lab_user, corp_sr_lab_user, corp_sr_lab_user_t2 and corp_senior_lab_user (spec lines ~307, 354, 368, 444).
- role-packs.data.yaml is byte-identical to spec/program/11-ROLE-MATRIX.data.yaml (checked with cmp). LD-141 bars me from editing role contents, and I may not edit the tests, so no change on my side can make this test pass.

Ruling needed (lead/arbiter), one of:
(a) The data is right: the sheet ticks Pathology Result for more roles (or the overlay text should add critical values to these tiers). Then fix the §3.1 text and the test's OVERLAY table (TESTS_WRONG).
(b) The text is right: remove the critical_value codes from those 4 roles in the data file. That is a spec/data change (CR to the owner of 11-ROLE-MATRIX). Note: it narrows these roles.
No RM-T03 production code is required: these tasks are test-only, and route-guard.test.ts passes in full.
