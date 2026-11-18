// T0B-SYNC-4 done_when (3): "the report print path adds the issued offline marker only while pending". Unit test of print.service createReportPrint over the single table fake DB of print.helpers.ts.
// PINNED (writer may dispute): PrintCtx gains an optional seam `offlineMarkers: { isPending(tx, tenantId, reportVersionId): Promise<boolean> }` (default = the production marker store of
// report.print_marker, state pending); when it answers true the print job row is written with `issued_offline: true`, otherwise `issued_offline: false`. The column is the writer's migration.
import { describe, expect, it } from 'vitest';
import { createBulkPrint, createReportPrint } from '../service/print.service.js';
import { printHandlers } from '../handlers/print.handlers.js';
import { VID, printSetup, released, draft, req } from './print.helpers.js';

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

// Review item 1 of T0B-SYNC-4: the bulk print path is part of "the report print path" (done_when 3): a bulk print that includes a version whose offline marker is still pending is issued offline too.
describe('issued offline marker on the BULK print path', () => {
  const V1 = VID(1, 1), V2 = VID(2, 1), V3 = VID(3, 1);
  const bulk = async (pendingIds: string[] | undefined, ids = [V1, V2], versions = [released(1, 1), released(2, 1)]) => {
    const s = printSetup({ versions }); const asked: unknown[][] = [];
    const offlineMarkers = pendingIds === undefined ? undefined : { async isPending(...a: unknown[]) { asked.push(a); return pendingIds.includes(a[2] as string); } };
    const out = await createBulkPrint(s.ctx(offlineMarkers ? { offlineMarkers } : {}), ids, 'plain');
    return { s, out, asked, row: s.prints()[0]! };
  };
  it('one pending version among the included ones: the bulk print job is written with issued_offline true; the seam was asked for this tenant and the included versions only', async () => {
    const { row, asked, s } = await bulk([V2]);
    expect(row['kind']).toBe('bulk'); expect(row['issued_offline']).toBe(true);
    expect(asked.length).toBeGreaterThan(0); for (const a of asked) { expect(a[1]).toBe(s.ctx().tenantId); expect([V1, V2]).toContain(a[2]); }
  });
  it('no pending version (confirmed, recall_required or none): issued_offline false', async () => {
    expect((await bulk([])).row['issued_offline']).toBe(false);
  });
  it('no seam (an online only deployment): issued_offline false, nothing breaks', async () => {
    expect((await bulk(undefined)).row['issued_offline']).toBe(false);
  });
  it('a pending marker on an EXCLUDED (unreleased) version does not mark the print; the excluded id is still listed', async () => {
    const { row, out, asked } = await bulk([V3], [V1, V3], [released(1, 1), draft(3, 1)]);
    expect(row['issued_offline']).toBe(false); expect(out.body.excluded_ids).toEqual([V3]); expect(asked.map((a) => a[2])).not.toContain(V3);
  });
  it('the response body (PrintJob) does not grow a field', async () => {
    expect(Object.keys((await bulk([V1])).out.body).filter((k) => !['copies', 'excluded_ids', 'expires_at', 'id', 'state', 'variant'].includes(k))).toEqual([]);
  });
  it('the createBulkPrint HANDLER keeps a seam the ctx brings (production default only when none): pending -> issued_offline true', async () => {
    const s = printSetup({ versions: [released(1, 1), released(2, 1)] });
    const offlineMarkers = { async isPending(_tx: unknown, _t: string, id: string) { return id === V1; } };
    const r = await printHandlers['createBulkPrint']!(req({ ids: [V1, V2], variant: 'plain' }) as never, s.ctx({ offlineMarkers }));
    expect(r).toMatchObject({ status: 202 }); expect(s.prints()[0]!['issued_offline']).toBe(true);
  });
});
