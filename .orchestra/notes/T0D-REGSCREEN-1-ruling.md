TESTS_WRONG — rs-c4.static.test.ts freezes frontdesk behaviour for the RS-C4 restyle (LD-140, "behaviour unchanged", test header lines 1-5), but T0D-REGSCREEN-1 is a feature task whose binding brief (LD-310) requires new behaviour on existing APIs. Applied to this task the guard asserts something the spec does not require.
Change in the test (tester-owned, `apps/web/src/features/frontdesk/__tests__/rs-c4.static.test.ts` + `rs-c4.signature.ts`): do NOT regenerate the baseline wholesale. Add one named, commented allow-list citing LD-310 / T0D-REGSCREEN-1 that permits exactly:
  - logic-file byte changes: `server/actions.ts`, `server/write.server.ts`, `server/read.server.ts`, `server/types.ts` (frontdesk);
  - added permissions: `catalog.price_list.manage`, `catalog.referrer.manage` (and `catalog.code_duplicate` only if the code names it);
  - added server import `@/features/catalog/server/catalogActions`; added symbols `createCreditPartyAction`, `createDoctorAction`, plus the one TRF action the writer names in the notes.
  Everything else stays pinned (no removed permission/route/import/symbol/field name, routes unchanged, route_files unchanged, other logic files byte-identical); keep the "not vacuous" check.
Reasons:
1. Brief done_when (2): Add client quick add "on the existing credit party API", Add Doctor "on the existing doctor API", TRF upload "using trf_attachment_ids", Laboratory/Franchise centre split, credit limit/consumed — all impossible without touching frontdesk server files/types.
2. Spec allows TRF upload before the order: spec/chunks/C4-frontdesk-billing/03-APP-FLOW.md:89 links `trf_attachment_ids` with `order_id IS NULL`; 07-SECURITY.md:94 lists `trf_attachment_ids` in the register body.
3. The two permission codes already exist in the catalog (spec/program/03-INTERFACE-CATALOG.md:3070-3071, referrer.manage "quick-add doctor"); gating UI on them adds no code, so LD-310 (d) "permission codes off limits" (no new codes, rs-c2 baseline) is not breached. No route is added (POST credit-parties/doctors/trf-attachments already exist).
4. LD-310 overrides spec text for this task (inbox: "LEAD DECISIONS (binding)"); LD-140 scoped RS-C4 only.
