# T0B-MISREPORTS-1 dispute (writer, 2026-11-18). Implementation written; 3 test points cannot pass by any implementation.

1. streaming.test.ts "an empty result still produces the header block and the label row": it counts lines `!l.startsWith('#') && l.trim()` on `Buffer.toString('utf8')`.
   Buffer.toString keeps the UTF-8 BOM, so line 1 is "﻿# Tenant: ..." (does not start with '#') -> count 2, not 1. The sibling case pins writeCsvStream
   bytes == writeCsv bytes (BOM + "# ..." first line, as AN-T15 pinned), so both cannot hold. Fix (tester): strip /^﻿/ before splitting (as xlsxRead.csvParts does).
2. probes/contract.probe.test.ts P13 (2 cases, pre-existing AN-T probe, not updated by the tester):
   (a) "only referral_incentive exports net_billed_paisa" — the contract (T0C-MISREPORTS-1) gives net_billed_paisa to sales_representative, repeated_patient and
       party_billing, and registry.static pins registry columns == contract columns. reportRegistry.test.ts already excepts exactly these three as NOT_PER_REFERRER;
       P13 needs the same exception list.
   (b) "net_billed_paisa appears only in the referral / billing-rollup files" — the SQL producing those contract columns must name the column
       (domain/misReports.ts, service/misReports.service.ts). Add those two paths to the allowed set. (Obfuscating the literal to dodge the probe would be dishonest.)
3. NOT a test defect, a dependency: registry.static "consultant is volume only" + "consultant: ... columns come from the contract" and reports.live consultant
   read contracts/openapi/analytics.yaml, which in this tree still has consultant.net_billed_paisa and default_sort net_billed_paisa. LD-346 (1) gives that edit to
   T0C-MISREPORTS-1 (reset to changes); it is not on this branch. The implementation already follows LD-346 (volume only), so these pass once that edit merges.
4. (debugger, 2026-11-18) reports.live.test.ts:77-83 paging case: `expect(whole.length).toBeGreaterThan(7)` for party_billing, but kit.ts:55 fixture has 4 parties and contracts/openapi/analytics.yaml:4115-4117 (party_billing, columns 4121-4129, no period column) defines one row per party. Max 4 rows; 7 is unreachable by any correct implementation. Fix (tester): more parties in the fixture or a smaller page size / lower bound for party_billing.
