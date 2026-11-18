# T0B-PARTYSET-1 dispute (writer, 2026-11-18). Code for all 13 + 5 handlers and the runtime effects is in; these failures are test / fixture / contract, not code.
Run (tests/partners/T0B-PARTYSET-1.pg.sh, whole partners + catalog + billing + boot): 10578 passed, 51 failed; billing whole suite + new suites rerun after one fix: 2372 passed, 8 failed (all item 1).
1. FIXTURE (partners/__tests__/partyset/helpers.ts fire()): ctx has no `events`, `core` or `ports.CatalogPort`, and the throwaway DB has no graphile task `partners.sync_price_list`.
   The EXISTING handlers need them (pipeline always supplies them): getPartner / listPartners / updatePartner call ctx.ports.CatalogPort + ctx.core (TypeError
   'getCreditParty'); updatePartner enqueues app.enqueue_job (P0001 unknown_task_identifier); every catalog doctor / credit party handler fails closed without
   ctx.events (auth.unauthenticated). Hits: masking.test.ts 8 tests, catalog partyset/doctor.test.ts 18 tests. Fix (tester): give fire() `events` (core createEvents),
   a CatalogPort (catalog manifest port) and `core.branch/centre`, and register the partners tasks in the pg.sh (or stub enqueue). The masking / validation code
   itself is exercised: tax_number / national_id_number / pan / doctor nid all go through partners/domain/id-number.ts.
2. OLD TESTS vs done_when (5): catalog creditParties.handlers.test.ts:140, creditParties.service.test.ts (4 tests) expect the FULL pan in getCreditParty / list / create /
   update replies; the brief, the contract (CreditParty pan description + examples "*****0000") and masking.test.ts require it masked. Re-pin those to the mask.
3. OLD TESTS vs contract T0C-PARTYSET-1 (fail without this task's code too): catalog probes/referrers.wording.test.ts + ci/wording.ci.test.ts (AC-11.5 "commission"
   banned, but catalog.yaml Doctor.commission_bp is contract; the source hits are the contract column name); partners probes/contract-probes.test.ts Q_ALLOWED lacks
   listPartyOnboarding / listNonCompliancePenalties (contract q params). Needs a lead ruling (AC-11.5 vs LD-321 doctor commission) and a Q_ALLOWED re-pin.
4. PRE-EXISTING, not this task: catalog import/* and template / static (T0B-TESTIMPORT-1 handlers absent, ids still pending), testmgmt/boot.test.ts pending-list
   and operation-count pins (TESTIMPORT ids pending; contract now has more operations).


## LEAD NOTE FOR THE ARBITER (17:15 NPT, from the lead; ground truth, please rule with it)
- Item 1 (fixture, helpers.ts fire() lacks events, core, CatalogPort and the graphile task): TESTS_WRONG, tester fixes it. Also check the other partyset test files for the same missing ctx.
- Item 2 (old catalog creditParties tests expect the full PAN): TESTS_WRONG, tester re-pins them to the masked value; the brief and the contract win.
- Item 3, AC-11.5 and doctor commission_bp: ALREADY RULED, LD-385. The doctor rate was removed from catalog.yaml (and from catalog.doctors in migration 20261117220000) by the rework of T0C-PARTYSET-1, which is DONE on main (17:05 NPT). This lane tree is stale: it does not have that commit yet. Verdict for that part: STALE_LANE, reset to implemented so the task START merges main. Nothing to rule on AC-11.5 and no CR is needed. The rate lives only in partners party settings (kind doctor). T0B-PARTYSET-1 must not select any doctors rate column.
- Item 3, Q_ALLOWED in partners probes/contract-probes.test.ts lacks listPartyOnboarding and listNonCompliancePenalties: TESTS_WRONG, tester re-pins.
- Item 4 (catalog import and testmgmt boot pins, TESTIMPORT): not this task, ruled in LD-386; T0B-TESTIMPORT-1 was released at 17:08 NPT. The boot.test.ts pending-list pin for the 5 ICD master ids is fixed there; if the same pin file is run here and fails only for TESTIMPORT ids, it is not a blocker for this task.
- CR-C0-PARTYSET-001 (access action party_id_number.reveal, summary masks, warning code, interest field, penalty particular seed) is non blocking: the lead copied it and will make contract rows. It is not a reason to hold the approval.
