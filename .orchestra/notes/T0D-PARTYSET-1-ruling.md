TESTS_WRONG — the t16 copy rule bans "commission" in every partners file, but the spec now allows the word in the partners party settings.

Reasons:
- spec/program/08-CR-REGISTER.md:3147 (A39-3 (iii), newest addendum, founder decision 2026-11-17) explicitly allows the word "commission" (any case) in "the partners party settings that already carry `commission_bp` and `tds_bp`". Per CLAUDE.md precedence the CR register (newest addendum wins) outranks the chunk docs 04-UI-UX (C13 04-UI-UX.md:248 "Never commission (04 L19)").
- A39-8 (08-CR-REGISTER.md:3152) narrows L19 (spec/research/04-consolidated-decisions.md:174) / B13 (:237); L19 itself only bans *labelling referral-incentive reporting* as commission, not a staff party setting field.
- contracts/openapi/partners.yaml:9335/9407/9480 (T0C-PARTYSET-1) fix the field name `commission_bp`; names are copied verbatim, so the code must contain it. LD-321 / done_when (2) require the "Commission And TDS" group.
- The writer correctly refused to obfuscate the string (that would game the test).

What to change in the test (`apps/web/src/features/partners/__tests__/t16.static.test.ts:110-116`), narrow, do not remove:
- Exempt from the `/commission/i` assertion ONLY the party settings files: `features/partners/components/CommercialSettings.tsx`, `features/partners/server/partyset.server.ts`, `features/partners/server/partysetActions.ts` (exact path allow list, like A39-6 (f)). Keep the IRD-claim assertion for all files including these.
- Keep `/commission/i` asserted on every other partners file (C13 portal copy, doctor volume screens stay "Samples this month").
- Add one guard: in the exempt files the word may appear only as `commission_bp`, the catalogue keys `partners.partyset.group.commission` / `partners.partyset.field.commission`, or the label of the Commission and TDS group/field; nothing implying a payout ("pay", "payable", "payout") may sit next to it (A39-1: no payout anywhere).
