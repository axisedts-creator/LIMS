// VERIFY-GREEN-4 behaviour pin (observation.service.ts reprocessPending, TS2379 x2 at the listPendingObservations calls): the fix may use a conditional spread for
// `analyteId`, so the repo is still asked EXACTLY the same question. PASSES now and must pass after. toEqual (not toStrictEqual) on purpose: an absent key and an
// `analyteId: undefined` key reach the SQL repo identically (it tests `q.analyteId !== undefined`), which is the "runtime output identical" claim of the brief.
// Other touched lines are pinned by existing suites that must stay green unchanged: settings.handlers.test.ts (#52 expectedVersion 2 / undefined), chart.service.test.ts
// (whole LjChartDto toEqual, series sorted by level_code then lot_no), worker ops.purge.test.ts (tenant guard), send_delivery.test.ts (8th attempt -> failed).
import { describe, expect, it } from 'vitest';
import { createObservationService } from '../service/observation.service.js';
import { ANA, INS, NOW, PENDING, PLN, makeAssembler, makeCtx, makeReprocessRepo, seedWith } from './reprocess.helpers.js';

const DAY = 86_400_000;
const rig = () => {
  const repo = makeReprocessRepo(seedWith([]));   // no stored observations: only the questions asked of the repo matter
  const c = makeCtx();
  const svc: any = createObservationService({ repo: repo.repo as any, assembler: makeAssembler().assembler as any });
  return { repo, run: (scope: object) => svc.reprocessPending(c.ctx, scope) as Promise<unknown>, cutoff: new Date(new Date(NOW as string | Date).getTime() - 7 * DAY).toISOString() };
};
const asked = (r: ReturnType<typeof rig>) => r.repo.callsOf('listPendingObservations').map((c: any) => c.args[0] as Record<string, any>);

describe('reprocessPending asks the repo the same listPendingObservations question (VERIFY-GREEN-4)', () => {
  it('instrument scope: ONE read, no analyte filter, the five pending statuses, bounded below by now - 7 days, no upper bound', async () => {
    const r = rig(); await r.run({ instrument_id: INS(1) });
    const qs = asked(r); expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q['instrumentId']).toBe(INS(1)); expect(q['analyteId']).toBeUndefined(); expect([...q['statuses']].sort()).toEqual(PENDING);
    expect(q['observedFrom']).toBe(r.cutoff); expect(q['observedBefore']).toBeUndefined();
    expect(Object.keys(q).filter((k) => q[k] !== undefined).sort()).toEqual(['instrumentId', 'observedFrom', 'statuses']);
  });
  it('plan scope: in-window read filtered to the plan\'s analyte; history read = no_plan only, older than the cut-off, same analyte, no lower bound', async () => {
    const r = rig(); await r.run({ plan_id: PLN(1) });
    const qs = asked(r); expect(qs).toHaveLength(2);
    const [inWin, hist] = qs as [Record<string, any>, Record<string, any>];
    expect(inWin['instrumentId']).toBe(INS(1)); expect(inWin['analyteId']).toBe(ANA(1)); expect([...inWin['statuses']].sort()).toEqual(PENDING);
    expect(inWin['observedFrom']).toBe(r.cutoff); expect(inWin['observedBefore']).toBeUndefined();
    expect(hist['instrumentId']).toBe(INS(1)); expect(hist['analyteId']).toBe(ANA(1)); expect(hist['statuses']).toEqual(['no_plan']);
    expect(hist['observedBefore']).toBe(r.cutoff); expect(hist['observedFrom']).toBeUndefined();
  });
});
