# T0B-MISREPORTS-1 dispute (writer, 2026-11-17). No implementation written: two pinned tests cannot both pass, and one file cannot pass in this tree.

## 1. consultant: registry.static vs reportRegistry contradict each other (tester open item 2), unsatisfiable by any implementation
- contracts/openapi/analytics.yaml:3985-3999 defines `consultant` with permission analytics.dashboard.read, no flag, column `net_billed_paisa`, one row per referrer_id.
- misreports/registry.static.test.ts:27-36 pins `getReport('consultant').exportColumns == contract columns` (incl. net_billed_paisa), `flag` undefined, permission from the contract.
- domain/__tests__/reportRegistry.test.ts:92-100 ("no export column of any other report carries per-referrer net billed") does NOT except consultant, so `consultant.net_billed_paisa` fails it.
- A39-3 (08-CR-REGISTER:3147) bans per-referrer money outside the gate, so the contract row itself conflicts with A39; the fix is upstream, not in T0B.
- Needs a ruling (lead/founder, money/regulatory, outside LD-310): (a) T0C contract change: drop net_billed_paisa from consultant (volume only, like top_referrers), or (b) gate consultant behind referralIncentiveReportEnabled + analytics.referral_report.read, or (c) A39 amended to allow it and the reportRegistry case excepts consultant. Then the tester aligns the two tests.

## 2. commission.live.test.ts cannot pass: the partners party settings table does not exist in this tree (tester open item 1)
- No migration or contract has commission_bp / tds_bp on a partners table (grep db/ contracts/: only the analytics.yaml descriptions). Migration 20261117220000 (PARTYSET) is absent; T0C/T0B-PARTYSET-1 not merged.
- Every case of the file calls need() and fails by name; A39-4 forbids C8 storing rates, so T0B cannot create the table (not an owned path, name would be invented).
- Needs: T0B-MISREPORTS-1 depends on T0B-PARTYSET-1 (and FINCTRL-1 for the ledger Hold status that done_when (2) requires), or the lead splits the two money reports into a follow-up row.

## Effect
done_when (6) "whole suite green three runs in a row" is unreachable until 1 and 2 are resolved. Recommend: re-queue after PARTYSET-1 merges and a ruling on consultant.
