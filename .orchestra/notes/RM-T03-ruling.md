CR_NEEDED — the spec itself is contradictory/missing (write the CR text into `.orchestra/cr/RM-T03.md` using spec/program/04-CHANGE-REQUESTS.md)

Reasons:
1. R1 (spec/program/11-ROLE-MATRIX.md:14): a tick grants that screen's codes, nothing more. R2 (:15): anything beyond a tick comes only from the §3 overlay, by role name.
2. §5.1 (:87): Pathology Result is ticked by 3 roles; it is the only §5.1 feature carrying `lab.critical_value.read` / `lab.critical_value.log_notification`. Pathologist_T3 is one of the 3 (:44); Sr. Lab User does NOT tick it (:15).
3. §3.1 overlay text (:49) gives critical values only to the three Pathologists; Sr/Senior Lab User tiers get "entry + verify + QC capture + worksheet management", Laboratory Lab User "entry only".
4. Yet the §9 appendix (:307, :354, :368, :444) and 11-ROLE-MATRIX.data.yaml give both critical_value codes to corp_laboratory_lab_user, corp_sr_lab_user, corp_sr_lab_user_t2, corp_senior_lab_user. Neither a tick (count 3, Sr not ticked) nor the overlay text explains those codes for all four.
5. The test encodes §3.1/§5.1 faithfully, so it is not TESTS_WRONG; the data file is binding and unchangeable under LD-141, so it is not IMPLEMENTATION_WRONG. The spec text and the data file contradict each other.
6. Writer must not edit the test or data; leave the one failing case red, referenced to CR-C2-RM-002 (.orchestra/cr/RM-T03.md), until the owner rules. route-guard.test.ts is unaffected.
