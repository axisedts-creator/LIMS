LD-356 applied by tester (isolation only, no assertion deleted/skipped/loosened, no implementation change):
1. homecollection/repository/__tests__/helpers.ts seedWorld: DELETE removed; after seed('homecollection.settings') the real row id is re-read and put in W.<side>.settings.
2. homecollection/__tests__/handovers/read.test.ts: :85 loop and :132 responseErrors scoped to this file's own handover ids (c,d / p1,p2,cf,dc). :84, :89-90 unchanged.
3. LD-355 exclude + --retry 2 timing command already in tests/partners/T0B-SALES-1.pg.sh.
Result of `bash tests/partners/T0B-SALES-1.pg.sh` after 1+2: 84 of 85 files green, 3511 tests pass; timing command 2 files / 6 tests green.
OPEN (not in the ruling, NOT touched): homecollection/__tests__/sync/guards.test.ts:255 "requires_reference method ... (tenant B settings)" -> expected ['rejected'] to equal ['applied']; red in both runs after item 1. It was green in writer verify run 1 (DELETE still present), so it is probably order/state of the tenant-B settings row (setSettings UPDATE runs before pushWorld's ensureSettings; row or settings cache differs now). Needs a lead ruling or a decision to let the tester isolate it.
