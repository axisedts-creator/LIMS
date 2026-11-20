# T0D-PARTYSET-1 dispute (writer): t16 copy rule "never commission" vs the pinned Commission and TDS group

## Facts (run 2026-11-20)
- partyset1 suite: 165 / 165 pass. Regression set: sales1 102, nav-complete.catalog 6, web-t33.components 76, uilist3 173, uiset1 69, rs-c2 74 all pass.
- t16 suite: 118 / 119. The one failure: `t16.static.test.ts` > "copy rules (04-UI-UX §6): never "commission" ..." — it greps EVERY source file under
  apps/web/src/features/partners and apps/web/src/app/(staff)/partners (any case) for /commission/i. Before this task it was 119 / 119.
- Hits: features/partners/components/CommercialSettings.tsx, features/partners/server/partyset.server.ts, features/partners/server/partysetActions.ts.
  They carry the contract field `commission_bp` (contracts/openapi/partners.yaml PartyCommercialSetting / PartyCommercialSettingSet, T0C-PARTYSET-1) and the
  catalogue keys `partners.partyset.group.commission` / `partners.partyset.field.commission`.

## Why the two cannot both hold
- LD-321 (binding for this task) and done_when 2 require a "Commission And TDS" group; partyset1.settings.test.tsx pins the group "Commission and TDS",
  the label "Commission (%)" and the body key `commission_bp`. The contract field name is fixed (CLAUDE.md: names verbatim).
- 04 L19 copy rule ("never commission") is pinned by t16 (C13 04-UI-UX line 248) and ALSO by billing copy-scan.mjs (C4, features/billing + app/(staff)/billing)
  and web-t33.nav (C3, features/catalog + app/(staff)/catalog). So moving the tab to billing or catalog only moves the failure (and the credit party
  detail lives in billing). The only "fix" left in partners is spelling the field name indirectly (e.g. `'commiss' + 'ion_bp'`), which games the test; I did not do that.

## Ask (arbiter / lead)
One of:
1. TESTS_WRONG (scope): t16 copy rule should exempt the PARTYSET commercial settings files (or the `commission_bp` field name and the
   `partners.partyset.*commission*` keys), since LD-321 / the founder evidence (Affiliation master "commission percent") supersede 04 L19 for this staff-only
   settings group; the rule's intent (partner-facing and referrer copy, C13 §6 "Doctor volumes are Samples this month") is untouched.
2. Or SPEC_CHANGE: rename the on-screen group / label (e.g. "Referral share and TDS") with a CR; the contract field `commission_bp` would still appear in code.
Writer stops here per the inbox rule. Everything else of the task is implemented and green (see T0D-PARTYSET-1-impl.md).
