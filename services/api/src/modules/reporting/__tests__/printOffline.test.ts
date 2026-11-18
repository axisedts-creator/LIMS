// T0B-SYNC-4 done_when (3): "the report print path adds the issued offline marker only while pending". Unit test of print.service createReportPrint over the single table fake DB of print.helpers.ts.
// PINNED (writer may dispute): PrintCtx gains an optional seam `offlineMarkers: { isPending(tx, tenantId, reportVersionId): Promise<boolean> }` (default = the production marker store of
// report.print_marker, state pending); when it answers true the print job row is written with `issued_offline: true`, otherwise `issued_offline: false`. The column is the writer's migration.
import { describe, expect, it } from 'vitest';
import { createReportPrint } from '../service/print.service.js';
import { VID, printSetup, released, draft } from './print.helpers.js';

const V = VID(1, 1);
const run = async (markers: unknown, versions = [released()], variant: 'letterhead' | 'plain' = 'plain') => {
  const s = printSetup({ versions });
  const seen: unknown[][] = [];
  const offlineMarkers = markers === undefined ? undefined : { async isPending(...a: unknown[]) { seen.push(a); return markers as boolean; } };
  const out = await createReportPrint(s.ctx(offlineMarkers ? { offlineMarkers } : {}), V, variant, 1);
  return { s, out, seen, row: s.prints()[0] };
};

describe('issued offline marker on the print path (only while the offline marker is pending)', () => {
  it('pending marker: the print job is written with issued_offline true, and the seam was asked for this tenant and this report version', async () => {
    const { row, seen, s } = await run(true);
    expect(row['issued_offline']).toBe(true);
    expect(seen).toHaveLength(1); expect(seen[0]![1]).toBe(s.ctx().tenantId); expect(seen[0]![2]).toBe(V);
  });
  it('no pending marker (confirmed, recall_required or none): issued_offline false', async () => {
    expect((await run(false)).row['issued_offline']).toBe(false);
  });
  it('no seam (an online only deployment): issued_offline false, nothing breaks', async () => {
    expect((await run(undefined)).row['issued_offline']).toBe(false);
  });
  it('the marker applies to letterhead and plain prints alike, and does not change the draft rule (a draft print still carries its draft watermark)', async () => {
    expect((await run(true, [released()], 'letterhead')).row['issued_offline']).toBe(true);
    const d = await run(true, [draft()], 'plain');
    expect(d.row['issued_offline']).toBe(true);
    expect(d.row['draft_watermark']).toBe(true);
  });
  it('the response body (PrintJob) does not grow a field: the marker is stored and rendered, never echoed', async () => {
    const { out } = await run(true);
    expect(Object.keys(out.body).sort()).toEqual(['copies', 'expires_at', 'id', 'state', 'variant']);
  });
  it('an unknown version stays common.not_found and asks nothing of the seam', async () => {
    const s = printSetup({ versions: [] });
    let asked = 0;
    await expect(createReportPrint(s.ctx({ offlineMarkers: { async isPending() { asked++; return true; } } }), V, 'plain', 1)).rejects.toMatchObject({ code: 'common.not_found' });
    expect(asked).toBe(0);
  });
});
