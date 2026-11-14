# HC-T16 dispute (debugger, 2026-11-14 ~10:50 NPT)
After the one implementation fix (sweep `missed` row: membership_id NULL, 05-SCHEMA.md:123 + :337 `visit_assignments__shape__ck`), verify went 20 -> 8 failures. Remaining 8 are defects in tests/fixtures/stand-in, which I may not edit:
1. purge_retention.live.test.ts:76 `JSON.stringify(calls)`: calls hold `ctx` (IdentityPort signature is `getTenantSettings(ctx, {keys})`, 03-INTERFACE-CATALOG.md:1646); ctx.ports is a Proxy (hc16.helpers.ts:48) that throws on `toJSON`. Task is correct.
2. purge_retention.live.test.ts:33 `o.payload ?? default`: payload `null` becomes `{tenant_id: A}`, so the task legitimately anonymises; test :120-121 then fails. Use `'payload' in o`.
3. sweep_missed_visits.live.test.ts:37 and :78 `String(date).slice(0,10)` on a pg `Date` gives 'Sat Apr 29'; compare via to_char / `::text` or format the Date.
4. sweep_missed_visits.live.test.ts:64 booking-visit seed violates `visits__order_when_active__ck` (fixture builds an active visit with no order; the check is in the stand-in/migration DDL).
5. anonymise_definer.live.test.ts (3 tests: DEFINER catalogue, FORCE-RLS owner policies, lims_app DELETE grants): not reproduced in isolation (needs the bootstrap DB); they assert stand-in DDL/grants, not task code. Owner of tests/bootstrap must check.
Need: TESTER to fix 1-4 (and 5 if confirmed test-side), then re-verify.
