# T0D-UNSLOP-1 dispute (writer): part (C) dashboard only. DashboardView NOT changed.
`features/analytics/__tests__/unslop1.dashboard.test.tsx` cannot pass together with two pinned tests the tester did not update (brief: "update every test that pinned the old markup"):
1. unslop1 (2): every `.lims-stat` shares ONE parent holding only tiles, at least 4 tiles.
   rs-c8.dashboard.test.tsx:172-181: at most 3 `.lims-stat` per region (pipeline / needs you / money) and at most 2 outside regions.
   One shared parent means all tiles are in the same region (<=3) or all outside (<=2): never >=4. Mathematically exclusive.
   Also rs-c8:155 forbids Patient visits inside the money strip, and rs-c8 #1 needs the pipeline counts inside `<li>`s.
2. unslop1 (1): ONE "Data may be out of date", not inside a tile and not in a tile's parent.
   an-t18.page.test.tsx:265-293 (03-APP-FLOW §5 S1 "stale badge per tile"): the stale marker must be inside the stale tile's cell and absent from the others.
Precedence: LD-353 rules 5/8 and LD-344 (newer, founder approved) back unslop1; an-t18 and rs-c8 pin the old markup.

# Part (D) one trail: done (unslop1.trail green), but these older tests pin the removed 2-crumb in-page trails and were not updated by the tester:
- anatomic t19.case (2 tests: "Pathology cases › accession"), catalog cattests1.tests-page:184 (a[href="/catalog"]), homecollection hc-t19.source ("Home visits" crumb), micro t20.page ("navigation /breadcrumb/"), frontdesk rs-c4.static billing_feature ("/billing/credit-parties" href was only the CreditPartyDetail crumb).
- DOM snapshots that contain the old crumbs or the new lims-align-end / title attributes: rs-c4.screens (credit party), rs-c6.screens (3), rs-c7.screens (3), rs-c8.screens.admin (schedule form). Need regeneration by the tester after review.

Ask: tester/arbiter updates an-t18 (per-tile stale cell -> one page note) and rs-c8 (region tile caps -> one tile row; pipeline counts as links without `.lims-stat`), then the writer implements (C).
