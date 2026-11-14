APPROVE
Reviewed 4a862fd4..HEAD (RM-T03 review fixes).
- matrix-replay.test.ts:37-44: OVERLAY gains ENTRY_CV (ENTRY + lab.critical_value.read + lab.critical_value.log_notification) for exactly corp_sr_lab_user, corp_sr_lab_user_t2, corp_senior_lab_user, corp_laboratory_lab_user; the other lab roles stay ENTRY. Matches LD-151 (CR-C2-RM-002 option a) and is cited in a comment. Nothing wider (LD-141).
- The overlay only excuses unticked-cell/strict-count leakage (lines 92, 108, 120); it never satisfies a tick, so R1 coverage is not weakened.
- role-packs.data.yaml is byte-identical to spec/program/11-ROLE-MATRIX.data.yaml (cmp). No production code, data, secrets or PHI changed; paths are owned test/notes files plus the CR renames.
- Ran vitest on matrix-replay.test.ts + route-guard.test.ts: 2 files, 318 passed, 0 failed.
Residual (not a defect): client D2 clinical-safety review may still narrow the 4 lab roles (option b).
