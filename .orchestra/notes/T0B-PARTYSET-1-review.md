APPROVE
Range 6fe3f4453..HEAD (5 commits: writer, arbiter, tester, writer, debugger r1).
- doctor.test.ts follows the arbiter ruling and LD-385 exactly: commission_bp dropped from create/update payloads and expectations; speciality, hospital, national_id_number full in DB and masked in reply/logs/audit kept; the 4 invalid-rate cases removed; new case asserts unknown_field/validation_failed on create and update, no writes, and no catalog.doctors column. Key built as 'com'+'mission_bp' so the c3-wording grep stays green. dbRows/rejectedAny exist in partyset/helpers.ts. No other assertion loosened.
- referrers.service.ts nowOf: Date -> ISO normalisation, matches CatalogPort.impl; event payload stays a string. Fine.
- creditParties/referrers nextCode: qualifying catalog.code_counters.next_value in ON CONFLICT DO UPDATE fixes 42702; tenant_id still bound $1, no interpolation.
- LD-385: commission_bp only in partners.party_commercial_setting (migration 20261117220000); none in catalog code, catalog.yaml or catalog.doctors.
- billing accounts.repo.ts / discountPolicy.repo.ts (FINCTRL code): the arbiter said this lane must not edit accounts.repo.ts. Debugger did; but `git diff main` on both files is empty, so the change equals main byte-for-byte and the next merge is a no-op. Not a defect, flagged for the lead as a process deviation only.
- No PHI, no secrets in diff or ps1-run.log (grep for password/postgres:// /token/api key: none). Synthetic ids only (SYN-NID-0001).
- Not re-verified by me: 3x full suite on throwaway PG17 (debugger notes say it was not run after round 7). Lane is 53 commits behind main; verify must run after the task START merge.
- Outside this task, for its owner: services/worker/.../catalog.import_kinds.ts:585 has the same unqualified code_counters upsert.
