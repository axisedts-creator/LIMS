```
Title: CR-C0-T0B-MISREPORTS-1: consultant report carries ungated per-referrer money (conflicts A39-3); two money reports need the partners party settings that do not exist yet
From chunk: C0-foundation-contracts (T0B-MISREPORTS-1, analytics/C8 handlers)   To owner: C0-0C (contract, T0C-MISREPORTS-1) + lead/founder (ruling) + T0C/T0B-PARTYSET-1
Type: api | schema
Blocking? yes — T0B-MISREPORTS-1 done_when (1),(2),(4),(6): registry.static.test.ts vs domain/__tests__/reportRegistry.test.ts cannot both pass for `consultant`; commission.live.test.ts cannot pass without the party settings rates.
Problem:
  (1) contracts/openapi/analytics.yaml:3985-3999 defines report `consultant`: one row per referrer_id with
      `net_billed_paisa`, permission analytics.dashboard.read, no flag. 08-CR-REGISTER A39-3 (line 3147) keeps
      "no per-referrer money outside the gate" for every report other than two_level_commission and tds
      (and referral_incentive, which is gated). The contract row violates A39-3; the registry test enforcing A39-3
      and the registry==contract test cannot both be green.
  (2) A39-3(iii)/A39-4 (lines 3147-3148) say rates come from "the partners party settings that already carry
      commission_bp and tds_bp" and C8 stores none. No table/column/contract with commission_bp or tds_bp exists
      in db/ or contracts/ (only analytics.yaml descriptions at 3940, 4093); PARTYSET migration 20261117220000
      (LD-321) is not merged. Held-ledger exclusion also needs the FINCTRL Hold status (LD-321).
Proposed change (exact):
  (1) Choose one (money/regulatory, outside LD-310 — founder/lead decides):
      (a) RECOMMENDED: analytics.yaml `consultant`: remove column `net_billed_paisa` and change
          default_sort to { column: tests_count, direction: desc } (volume only, like top_referrers); T0C updates
          misreports1-openapi.test.ts if it pins that column; registry tests unchanged.
      (b) Gate `consultant` like referral_incentive: permission analytics.referral_report.read, flag
          referralIncentiveReportEnabled, access log referral_report.view; A39 amended to list it; tester adds
          consultant to MONEY_CODES/gate cases.
      (c) Amend A39-3 to allow ungated per-referrer net billed for consultant; tester excepts consultant in
          reportRegistry.test.ts "no export column ... per-referrer net billed".
  (2) Add dependencies T0B-MISREPORTS-1 -> T0B-PARTYSET-1 and T0B-FINCTRL-1 (or split two_level_commission
      and tds into a follow-up row T0B-MISREPORTS-2 depending on them), so the rates and Hold status exist.
Backward compatible? (a) yes — consultant is new in T0C-MISREPORTS-1, no consumer yet (T0D-MISREPORTS-1 not built).
Tenant/security impact: removes/gates per-referrer money exposure (04 L19, D-44, A39-2/3); no RLS or PHI change.
IRD/regulatory impact: 04 L19 (UNVERIFIED, A39-5) — referral money must stay behind the gate.
Alternatives considered: T0B creating the party settings table (rejected: not owned, A39-4 forbids C8 storing
  rates, name would be invented); excepting consultant in the registry test (rejected: loosens an assertion
  beyond A39-6(c)).
Tests that will prove it: registry.static.test.ts and reportRegistry.test.ts both green for consultant;
  security probe A39-6(e) shows no per-referrer money in consultant output for a non-gated user;
  commission.live.test.ts green once PARTYSET/FINCTRL tables are on the branch.
```
