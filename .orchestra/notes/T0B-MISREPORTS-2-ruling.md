TESTS_WRONG — both disputed cases of src/modules/analytics/__tests__/probes/contract.probe.test.ts are stale pins written before A39; change only these two lines/blocks:
1. Line 92: `expect(owners).toEqual([['referral_incentive', 'referralIncentiveReportEnabled']]);` -> `expect(owners).toEqual([['referral_incentive', 'referralIncentiveReportEnabled'], ['two_level_commission', 'referralIncentiveReportEnabled']]);` (order checked: referral_incentive is in ENTRIES at reportRegistry.ts:69, before the MIS_ORDER spread at :81 that yields two_level_commission).
2. Lines 95-97 `allowed` Set: add `'service/misReports.service.ts', // LD-402: A39 two_level_commission SQL outputs the contract column net_billed_paisa`.
Reasons:
- spec/program/08-CR-REGISTER.md:3145 (A39-1) adds two_level_commission with the columns pinned by the contract; contracts/openapi/analytics.yaml:3938,3951 gives it `net_billed_paisa` (Net billed). Contract (03/T0C) outranks the AN-T21 probe (CLAUDE.md precedence).
- 08-CR-REGISTER.md:3146 (A39-2a) gates it by the same flag referralIncentiveReportEnabled, "no new flag", so the P13 intent (net billed only behind the flag gate) still holds; only the literal owner list is stale.
- 08-CR-REGISTER.md:3148 (A39-4) base = M33 net billed, so the report SQL in service/misReports.service.ts must name the column; it is the only new non-test hit (grep checked: other 6 hits are already allowed). Not a scan dodge.
- Line 80-82 (only getReferralIncentiveReport response carries net_billed_paisa) is NOT changed: report rows come via x-report-definitions, not a response schema, and that case passes.
- Do not touch registry.static.test.ts, reportRegistry.ts, misReports.ts, misReports.service.ts for this ruling. Held-entry exclusion (A39-4, status <> 'held') needs nothing.
- Separate, not ruled here: A39-4 "parent party and its sub party" has no party->parent link in T0C-SALES-1 tables (CR-C0-MISREPORTS2-001 item 1); money/legal decision stays with the founder (LD-310, LD-402). Leave blocked; do not re-dispute.

----
LEAD RULING, LD-408 (CR-C0-MISREPORTS2-001, item 1): founder decided the parent/sub-party rule.
Verbatim in chat (08:04 NPT): "keep the partner b2b name rather than a person so that we dont need
look for a person another if single lab has multi outlet then they should be able to select anyone
specific outlet or parent will get the money."

Picks the CR's Alternative, not its Suggestion: no derivation through partners.sales_representative
manager hierarchy (that is a person/employee lookup, explicitly ruled out). Instead an explicit party
to parent-party link stored directly on the party.

EXACT SCHEMA:
1. partners.party_commercial_setting: add parent_credit_party_id, nullable, FK to the same
   credit-party identity this task already rates from (confirm the exact existing id/type to FK
   against -- do not invent a new identity concept). NULL = standalone, level 1, parent_party_id and
   parent_party_name stay '' exactly as today's behaviour.
2. Same table: add credit_self_not_parent boolean not null default false. This is the founder's
   "select any specific outlet" mechanism:
   - parent_credit_party_id set AND credit_self_not_parent = false (default) -> level 2, commission
     rolls up to the parent (parent_party_id/parent_party_name populated from the parent party).
   - parent_credit_party_id set AND credit_self_not_parent = true -> stays level 1 for this purpose
     (parent_party_id/parent_party_name stay ''), even though a parent link exists on file -- the
     outlet keeps its own commission.
3. Additive only. No change to T0C-SALES-1's sales_representative / party_sales_assignment tables --
   those are not used for this rule.
4. commission.live.test.ts: add the three cases above (no parent / parent+rollup / parent+self-keep)
   per the CR's own note that "a rule test is added after the ruling." Column/migration mechanics
   (naming, index, exact FK target) are the writer's normal call, not re-litigated here; the two
   fields and their semantics above are fixed.

CR item 2 (Held ledger entries / commission base): confirmed, not a new decision. Base stays invoice
based (billing.invoices, M33); Held lives only on billing.account_ledger_entries with no join to the
invoice base, so it correctly has zero effect. The already-implemented neutrality is correct as is --
nothing to build here.

Reset: C0-0J T0B-MISREPORTS-2 to changes.
