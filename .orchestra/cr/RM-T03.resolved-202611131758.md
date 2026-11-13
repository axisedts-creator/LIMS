```
Title: CR-C2-RM-002: 11-ROLE-MATRIX overlay text vs data file disagree on lab.critical_value.* for four ELabCorp lab roles
From chunk: C2            To owner: lead (owner of spec/program/11-ROLE-MATRIX.md and .data.yaml under LD-141; program-level)
Type: bug
Blocking? yes — C2 06-IMPLEMENTATION-PLAN row RM-T03 (matrix-replay.test.ts, elabcorp_default, "feature Menu / Pathology Result: ticked-role count matches the sheet" fails 4 > 3)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  AC 11-ROLE-MATRIX §4 item 2 (matrix replay) cannot pass. R1 (11-ROLE-MATRIX.md:14) says a tick grants only that screen's codes; R2 (:15) says
  extra codes come only from the §3 overlay. §5.1 (:87) says Pathology Result (the only §5.1 screen with lab.critical_value.read /
  lab.critical_value.log_notification) is ticked by 3 roles, Pathologist_T3 among them (:44), and Sr. Lab User does not tick it (:15).
  The §3.1 overlay paragraph (:49) gives critical values only to the Pathologists. But the §9 appendix (:307, :354, :368, :444) and
  11-ROLE-MATRIX.data.yaml give both critical_value codes to corp_laboratory_lab_user, corp_sr_lab_user, corp_sr_lab_user_t2,
  corp_senior_lab_user. LD-141 forbids editing role contents, so C2 cannot reconcile.
Proposed change (exact): owner picks one:
  (a) Data is right: amend 11-ROLE-MATRIX.md:49 so the Sr.Lab User / Sr. Lab User_T2 / Senior Lab User overlay reads
      "entry + verify + critical values (read, log notification) + QC capture + worksheet management", and state whether
      Laboratory Lab User ticks Pathology Result (then §5.1 :87 count and :15 rationale must agree) or also gets critical values by overlay.
      C2 then updates the OVERLAY table in matrix-replay.test.ts to match.
  (b) Text is right: remove lab.critical_value.read and lab.critical_value.log_notification from the four roles in
      11-ROLE-MATRIX.data.yaml and §9 (narrows those roles; permission counts in §3.1 :35, :40, :41, :47 change). C2 re-copies the data file.
Backward compatible? (a) yes. (b) no — narrows four seeded templates; no tenant seeded in production yet, re-apply via RM-T02 safe re-apply.
Tenant/security impact: no RLS change, no new PHI field, no new public surface. Critical-value access is clinical-safety relevant
  (who may see/log critical results); decision belongs to the client (D2 open decision).
IRD/regulatory impact: n/a (not billing).
Alternatives considered: widening the test to tolerate the extra holders — rejected (LD-141: never widen to make a test pass; report the mismatch).
Tests that will prove it: matrix-replay.test.ts (all 318 cases) green with the chosen text/data; RM-T02 seed test still byte-equal to the data file.
```
