```
Title: CR-C0-T0B-MISREPORTS-1 (2): three ungated MIS reports return a `net_billed_paisa` field, which C8 02-TRD:173 and 07-SECURITY P13 reserve for referral_incentive
From chunk: C0-foundation-contracts (T0B-MISREPORTS-1, analytics/C8 handlers)   To owner: C0-0C (contract, T0C-MISREPORTS-1) + lead (ruling)
Type: api
Blocking? yes — T0B-MISREPORTS-1 done_when (6) "the existing analytics suite stays green unchanged": probes/contract.probe.test.ts P13
  (lines 88-93 and 94-102) cannot pass while registry.static.test.ts pins registry columns == contract columns.
Problem:
  contracts/openapi/analytics.yaml gives the column `net_billed_paisa` to three reports without the referral gate:
  sales_representative (3974, also default_sort 3976, analytics.dashboard.read), repeated_patient (4038, analytics.dashboard.read),
  party_billing (4127, analytics.collections.read). None is per referrer (rows are per representative / patient / billing party),
  so A39-3 (08-CR-REGISTER:3147, "no per-referrer money outside the gate") is arguably met, but the field-name rule is literal and
  was not superseded: spec/chunks/C8-analytics-mis/02-TRD.md:173 "no other endpoint, export, schedule or dashboard card returns
  `net_billed_paisa`"; 07-SECURITY.md:54 and :98 (P13); 01-PRD.md:283 (M33 "Served only in the referral business report");
  analytics.yaml:1118 itself ("The only response carrying net_billed_paisa (D-44)"). A39-8 (08-CR:3151) supersedes D-44 only for
  two_level_commission and tds. The contract therefore contradicts higher-precedence spec text; T0B may not edit analytics.yaml (A39-7).
Proposed change (exact):
  (a) RECOMMENDED: analytics.yaml: rename the column `net_billed_paisa` to the existing contract name `net_paisa` (already used at
      3927 and 4081, title "Net") in sales_representative, repeated_patient and party_billing, and sales_representative
      default_sort.column -> net_paisa. T0C updates misreports1-openapi.test.ts if it pins those names. P13 and every probe stay unchanged;
      T0B registry/SQL follow the contract; the NOT_PER_REFERRER exception in domain/__tests__/reportRegistry.test.ts becomes unnecessary.
  (b) Amend 02-TRD:173 / 07-SECURITY P13 / PRD M33 to scope the ban to per-referrer net billed and name these three codes as
      exceptions; the tester then adds the same exception list to P13 (both cases) — lead decision, spec edit.
Backward compatible? (a) yes — the three codes are new in T0C-MISREPORTS-1; no consumer yet (T0D-MISREPORTS-1 not built).
Tenant/security impact: none on RLS/PHI; keeps the single-carrier invariant of D-44 that P13 checks mechanically.
IRD/regulatory impact: 04 L19 (UNVERIFIED, A39-5) unchanged; (a) avoids any reading of these columns as referral money.
Alternatives considered: obfuscating the literal in T0B SQL to dodge the probe (rejected: dishonest, the field is still returned);
  T0B renaming the column alone (rejected: breaks registry == contract and T0B does not own the contract).
Tests that will prove it: probes/contract.probe.test.ts P13 all cases green unchanged; registry.static.test.ts green;
  reports.live.test.ts column cases green for the three codes.
```
