// C6-T21 — ReportingPort.getReleasedReports beyond the 8 C0 contract cases (02-TRD §7.1, 03-IC §4.7, 05-SCHEMA §4 partner policy, 08 R1/R8/R25; AC-15.1).
// Harness: reportingport.helpers.ts (in-memory SQL fake; see its header for the SQL the impl may use: single-table SELECTs, `col = $n`, `col IN (..)`,
// `col = ANY($n::uuid[])`, `(released_at, id) < ($a, $b)`, ORDER BY, LIMIT; parameterised; tenant predicate `tenant_id = $n` on every statement).
// Test names deliberately contain no "(n)" so they never collide with the contract case names.
import { describe, expect, it } from 'vitest';
import { DAY, NOW, PAT, PAT2, P1, P2, CENTRE_X, TENANT_A, TENANT_B, id, isoDay, makeReportingWorld, rejection, ver, PORTAL_ORIGIN } from './reportingport.helpers.js';

const O = (n: number) => id(0x200 + n);
const R = (n: number) => id(0x300 + n);

async function world(reports: Array<Record<string, any>>, extra: Record<string, any> = {}) {
  const w = await makeReportingWorld();
  await w.harness.seed({ reports: reports.map((r, i) => ({ id: id(0x400 + i), ...r })), ...extra });
  return w;
}
const list = (w: Awaited<ReturnType<typeof world>>, filter: object, key = 'A', extra: object = {}) =>
  w.harness.impl.getReleasedReports(w.harness.ctxFor(key), { filter, ...extra }) as Promise<{ items: any[]; nextCursor?: string }>;
const ids = (items: any[]) => items.map((r) => `${r.reportId}:${r.versionNo}`);
const A = TENANT_A, B = TENANT_B;

describe('getReleasedReports: result shape and mapping', () => {
  it('returns exactly the ReleasedReportSummary fields, mapped from the version row and its QR snapshot', async () => {
    const w = await world([ver(A, { reportId: R(1), orderId: O(1), releasedAt: isoDay(3), panelNames: ['Complete Blood Count', 'Liver Function Test'] })]);
    const { items, nextCursor } = await list(w, { orderId: O(1) });
    expect(nextCursor).toBeUndefined();
    expect(items).toEqual([{ reportId: R(1), versionNo: 1, orderId: O(1), patientId: PAT, kind: 'final', status: 'valid', releasedAt: isoDay(3),
      panelNames: ['Complete Blood Count', 'Liver Function Test'], smartSummaryAvailable: false }]);
    expect(Object.keys(items[0]!).sort()).toEqual(['kind', 'orderId', 'panelNames', 'patientId', 'releasedAt', 'reportId', 'smartSummaryAvailable', 'status', 'versionNo']);
  });

  it('passes all five kinds through, including addendum (08 R1)', async () => {
    const kinds = ['final', 'partial', 'preliminary', 'amended', 'addendum'];
    const w = await world(kinds.map((kind, i) => ver(A, { reportId: R(10 + i), orderId: O(10 + i), kind, releasedAt: isoDay(1 + i) })));
    const got = (await list(w, { patientId: PAT })).items;
    expect(got.map((r) => r.kind).sort()).toEqual([...kinds].sort());
  });

  it('lists a released and a superseded version with status valid / superseded, each with ITS OWN panel names', async () => {
    const w = await world([
      ver(A, { reportId: R(2), orderId: O(2), versionNo: 1, status: 'superseded', releasedAt: isoDay(1), panelNames: ['CBC'] }),
      ver(A, { reportId: R(2), orderId: O(2), versionNo: 2, kind: 'amended', releasedAt: isoDay(2), panelNames: ['CBC', 'LFT'] }),
    ]);
    const all = (await list(w, { orderId: O(2), includeSuperseded: true })).items;
    expect(all.map((r) => [r.versionNo, r.status, r.panelNames, r.kind]).sort()).toEqual([[1, 'superseded', ['CBC'], 'final'], [2, 'valid', ['CBC', 'LFT'], 'amended']]);
  });

  it('smartSummaryAvailable is true only for the version whose smart snapshot columns are set (08 A4.4)', async () => {
    const w = await world([
      ver(A, { reportId: R(3), orderId: O(3), versionNo: 1, status: 'superseded', releasedAt: isoDay(1) }),
      ver(A, { reportId: R(3), orderId: O(3), versionNo: 2, kind: 'amended', releasedAt: isoDay(2), smart: true }),
      ver(A, { reportId: R(4), orderId: O(4), releasedAt: isoDay(3) }),
    ]);
    const o3 = (await list(w, { orderId: O(3), includeSuperseded: true })).items;
    expect(o3.map((r) => [r.versionNo, r.smartSummaryAvailable]).sort()).toEqual([[1, false], [2, true]]);
    expect((await list(w, { orderId: O(4) })).items.map((r) => r.smartSummaryAvailable)).toEqual([false]);
  });

  it('never lists a version that is not released/superseded, even with includeSuperseded', async () => {
    const w = await world(['rendering', 'rendered', 'render_failed', 'discarded'].map((dbStatus, i) =>
      ver(A, { reportId: R(20 + i), orderId: O(20 + i), dbStatus, released: false, releasedAt: null })));
    expect((await list(w, { patientId: PAT, includeSuperseded: true })).items).toEqual([]);
    for (let i = 0; i < 4; i++) expect((await list(w, { orderId: O(20 + i), includeSuperseded: true })).items).toEqual([]);
  });
});

describe('getReleasedReports: filters', () => {
  it('partnerId filter returns that partner\'s reports of THIS tenant only (reports.partner_id from OrderSummary.partnerId, 08 R25)', async () => {
    const w = await world([
      ver(A, { reportId: R(30), orderId: O(30), partnerId: P1, releasedAt: isoDay(1) }),
      ver(A, { reportId: R(31), orderId: O(31), partnerId: P2, releasedAt: isoDay(2) }),
      ver(A, { reportId: R(32), orderId: O(32), partnerId: null, releasedAt: isoDay(3) }),
      ver(B, { reportId: R(33), orderId: O(33), partnerId: P1, releasedAt: isoDay(4) }),
    ]);
    expect(ids((await list(w, { partnerId: P1 })).items)).toEqual([`${R(30)}:1`]);
    expect(ids((await list(w, { partnerId: P1 }, 'B')).items)).toEqual([`${R(33)}:1`]);
  });

  it('centreId and orderId and patientId filters select exactly their rows', async () => {
    const w = await world([
      ver(A, { reportId: R(40), orderId: O(40), centreId: CENTRE_X, releasedAt: isoDay(1) }),
      ver(A, { reportId: R(41), orderId: O(41), patientId: PAT2, releasedAt: isoDay(2) }),
      ver(A, { reportId: R(42), orderId: O(42), releasedAt: isoDay(3) }),
    ]);
    expect(ids((await list(w, { centreId: CENTRE_X })).items)).toEqual([`${R(40)}:1`]);
    expect(ids((await list(w, { patientId: PAT2 })).items)).toEqual([`${R(41)}:1`]);
    expect(ids((await list(w, { orderId: O(42) })).items)).toEqual([`${R(42)}:1`]);
  });

  it('releasedFrom / releasedTo narrow by released_at', async () => {
    const w = await world([1, 2, 3, 4, 5].map((d) => ver(A, { reportId: R(50 + d), orderId: O(50 + d), releasedAt: isoDay(d) })));
    const got = (await list(w, { patientId: PAT, releasedFrom: isoDay(2, 12), releasedTo: isoDay(4, 12) })).items;
    expect(got.map((r) => r.releasedAt).sort()).toEqual([isoDay(3), isoDay(4)]);
    expect((await list(w, { patientId: PAT, releasedFrom: isoDay(4, 12) })).items.map((r) => r.releasedAt).sort()).toEqual([isoDay(5)]);
  });

  it('rejects anything but exactly one of orderId|patientId|partnerId|centreId with common.validation_failed', async () => {
    const w = await world([ver(A, { reportId: R(60), orderId: O(60), releasedAt: isoDay(1) })]);
    const bad: object[] = [{}, { includeSuperseded: true }, { orderId: O(60), centreId: CENTRE_X }, { patientId: PAT, partnerId: P1 }, { orderId: O(60), patientId: PAT, partnerId: P1, centreId: CENTRE_X },
      { orderId: 'not-a-uuid' }, { orderId: '' }, { orderId: null }, { orderId: [O(60)] }, { orderId: 42 }, { unknownKey: O(60) }];
    for (const f of bad) expect((await rejection(list(w, f))).code, JSON.stringify(f)).toBe('common.validation_failed');
    expect((await rejection(w.harness.impl.getReleasedReports(w.harness.ctxFor('A'), {}))).code).toBe('common.validation_failed');
  });

  it('SQL metacharacters in a filter value are rejected before any statement is built; nothing reaches the SQL text', async () => {
    const w = await world([ver(A, { reportId: R(61), orderId: O(61), releasedAt: isoDay(1) })]);
    const evil = `${O(61)}' OR '1'='1`;
    const before = w.reads.length;
    expect((await rejection(list(w, { orderId: evil }))).code).toBe('common.validation_failed');
    expect((await rejection(list(w, { patientId: `${PAT}; DROP TABLE reporting.reports; --` }))).code).toBe('common.validation_failed');
    expect(w.reads.slice(before).filter((s) => /DROP|OR '1'/i.test(s.text))).toEqual([]);
  });
});

describe('getReleasedReports: tenant isolation, actors, SQL hygiene', () => {
  it('another tenant sees none of tenant A\'s rows through any filter', async () => {
    const w = await world([ver(A, { reportId: R(70), orderId: O(70), partnerId: P1, centreId: CENTRE_X, releasedAt: isoDay(1) })]);
    for (const f of [{ orderId: O(70) }, { patientId: PAT }, { partnerId: P1 }, { centreId: CENTRE_X }]) {
      expect((await list(w, { ...f, includeSuperseded: true }, 'B')).items, JSON.stringify(f)).toEqual([]);
    }
    expect((await list(w, { orderId: O(70) })).items.length).toBe(1);
  });

  it('partner actor: sees only its own partner\'s released/superseded rows whatever filter it asks for', async () => {
    const w = await world([
      ver(A, { reportId: R(80), orderId: O(80), partnerId: P1, releasedAt: isoDay(1) }),
      ver(A, { reportId: R(81), orderId: O(81), partnerId: null, releasedAt: isoDay(2) }),                         // same patient, no partner
      ver(A, { reportId: R(82), orderId: O(82), partnerId: P2, releasedAt: isoDay(3) }),
      ver(A, { reportId: R(83), orderId: O(83), partnerId: P1, versionNo: 1, status: 'superseded', releasedAt: isoDay(4) }),
      ver(A, { reportId: R(83), orderId: O(83), partnerId: P1, versionNo: 2, kind: 'amended', releasedAt: isoDay(5) }),
      ver(A, { reportId: R(84), orderId: O(84), partnerId: P1, dbStatus: 'rendered', released: false, releasedAt: null }),
    ]);
    const who = w.harness.ctxFor('A:partner:p1').actor.id;
    await w.harness.seed({ partnerOfActor: { [who]: P1 } });
    expect(ids((await list(w, { partnerId: P1 }, 'A:partner:p1')).items).sort()).toEqual([`${R(80)}:1`, `${R(83)}:2`]);
    expect(ids((await list(w, { partnerId: P1, includeSuperseded: true }, 'A:partner:p1')).items).sort()).toEqual([`${R(80)}:1`, `${R(83)}:1`, `${R(83)}:2`]);
    expect(ids((await list(w, { patientId: PAT }, 'A:partner:p1')).items).sort()).toEqual([`${R(80)}:1`, `${R(83)}:2`]);   // not R(81)/R(82)
    expect((await list(w, { partnerId: P2 }, 'A:partner:p1')).items).toEqual([]);
    expect((await list(w, { orderId: O(81) }, 'A:partner:p1')).items).toEqual([]);
    expect((await list(w, { orderId: O(84), includeSuperseded: true }, 'A:partner:p1')).items).toEqual([]);
  });

  it('every statement is a parameterised, tenant-scoped SELECT; getReleasedReports writes nothing', async () => {
    const w = await world([ver(A, { reportId: R(90), orderId: O(90), releasedAt: isoDay(1) }), ver(B, { reportId: R(91), orderId: O(91), releasedAt: isoDay(2) })]);
    const before = w.reads.length; const writesBefore = w.db.writes().length;
    await list(w, { patientId: PAT, includeSuperseded: true }, 'A', { limit: 5 });
    await list(w, { patientId: PAT }, 'A', { limit: 1 });
    const mine = w.reads.slice(before);
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) {
      expect(s.text, s.text).toMatch(/^\s*select\b/i);
      expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
      expect(s.text, s.text).not.toMatch(/\bjoin\b/i);                                  // the fake models single-table statements (and RLS-friendly reads)
      expect(s.text, s.text).not.toContain(A); expect(s.text, s.text).not.toContain(PAT);
      expect(s.values).toContain(A);
    }
    expect(w.db.writes().length).toBe(writesBefore);
  });
});

describe('getReleasedReports: paging', () => {
  it('default page is 50, the rest follows on nextCursor, no row twice, newest-first or oldest-first but consistent', async () => {
    const w = await world(Array.from({ length: 60 }, (_, i) => ver(A, { reportId: id(0x1000 + i), orderId: id(0x2000 + i), releasedAt: new Date(Date.UTC(2026, 8, 1) + i * 3600_000).toISOString() })));
    const p1 = await list(w, { patientId: PAT });
    expect(p1.items.length).toBe(50); expect(typeof p1.nextCursor).toBe('string');
    const p2 = await list(w, { patientId: PAT }, 'A', { cursor: p1.nextCursor });
    expect(p2.items.length).toBe(10); expect(p2.nextCursor).toBeUndefined();
    const all = [...ids(p1.items), ...ids(p2.items)];
    expect(new Set(all).size).toBe(60);
    const times = [...p1.items, ...p2.items].map((r) => Date.parse(r.releasedAt));
    const asc = times.every((t, i) => i === 0 || t >= times[i - 1]!), desc = times.every((t, i) => i === 0 || t <= times[i - 1]!);
    expect(asc || desc).toBe(true);
  });

  it('rows sharing one released_at are split across pages by the id tie-break: none lost, none repeated', async () => {
    const same = isoDay(2);
    // version ids DEscend in insertion order, so only an explicit `id` tie-break (not stable-sort luck) yields a consistent keyset order
    const w = await world(Array.from({ length: 5 }, (_, i) => ver(A, { id: id(0x1500 - i), reportId: id(0x1100 + i), orderId: id(0x2100 + i), releasedAt: same })));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const p = await list(w, { patientId: PAT }, 'A', { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(p.items.length).toBeLessThanOrEqual(2); seen.push(...ids(p.items)); cursor = p.nextCursor; pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5); expect(seen.length).toBe(5);
  });

  it('limit must be an integer 1..200; 201 and above is common.validation_failed (/limit), 200 is accepted (02-CV §4.3)', async () => {
    const w = await world(Array.from({ length: 205 }, (_, i) => ver(A, { reportId: id(0x1200 + i), orderId: id(0x2200 + i), releasedAt: new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString() })));
    for (const limit of [0, -1, 1.5, Number.NaN, '5' as any]) expect((await rejection(list(w, { patientId: PAT }, 'A', { limit }))).code, String(limit)).toBe('common.validation_failed');
    expect((await list(w, { patientId: PAT }, 'A', { limit: 200 })).items.length).toBe(200);
    for (const limit of [201, 1000]) {
      const e = await rejection(list(w, { patientId: PAT }, 'A', { limit }));
      expect(e.code, String(limit)).toBe('common.validation_failed');
      expect(e.errors?.[0]?.path, String(limit)).toBe('/limit');
    }
  });

  it('a malformed cursor is common.invalid_cursor (never a 500, never an empty success)', async () => {
    const w = await world([ver(A, { reportId: R(95), orderId: O(95), releasedAt: isoDay(1) })]);
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    for (const cursor of ['%%%', 'x', '', b64('nonsense'), b64('{"a":1}'), b64(`not-a-time|${R(95)}`), b64(`${isoDay(1)}|not-a-uuid`)]) {
      expect((await rejection(list(w, { patientId: PAT }, 'A', { cursor }))).code, cursor).toBe('common.invalid_cursor');
    }
  });

  it('a cursor replayed under another filter or tenant never yields rows outside that filter/tenant', async () => {
    const w = await world([
      ...Array.from({ length: 4 }, (_, i) => ver(A, { reportId: id(0x1300 + i), orderId: id(0x2300 + i), releasedAt: isoDay(1 + i) })),
      ver(A, { reportId: R(96), orderId: O(96), patientId: PAT2, releasedAt: isoDay(9) }),
      ver(B, { reportId: R(97), orderId: O(97), releasedAt: isoDay(8) }),
    ]);
    const p = await list(w, { patientId: PAT }, 'A', { limit: 2 });
    expect(p.nextCursor).toBeDefined();
    const other: any = await list(w, { patientId: PAT2 }, 'A', { cursor: p.nextCursor }).then((x) => x, (e) => e);
    if (other?.items) for (const r of other.items) expect(r.patientId).toBe(PAT2); else expect(other.code).toBe('common.invalid_cursor');
    const cross: any = await list(w, { patientId: PAT }, 'B', { cursor: p.nextCursor }).then((x) => x, (e) => e);
    if (cross?.items) for (const r of cross.items) expect(ids([r])[0]).toBe(`${R(97)}:1`); else expect(cross.code).toBe('common.invalid_cursor');
  });
});

describe('ReportingPort composition', () => {
  it('exposes getReleasedReports and issuePortalLink; issuePortalLink delegates to the T20 service ({portal origin}/r/{token}, hash only stored)', async () => {
    const w = await world([ver(A, { reportId: R(98), orderId: O(98), releasedAt: isoDay(1) })]);
    expect(typeof w.harness.impl.getReleasedReports).toBe('function'); expect(typeof w.harness.impl.issuePortalLink).toBe('function');
    const out = await w.harness.impl.issuePortalLink(w.harness.ctxFor('A', { now: () => NOW as any }), { reportId: R(98), channel: 'sms', recipientKind: 'patient' });
    expect(out.url).toMatch(new RegExp(`^${PORTAL_ORIGIN.replace(/[.]/g, '\\.')}/r/[A-Za-z0-9_-]{22,}$`));
    expect(out.expiresAt).toBe(new Date(Date.parse(NOW) + 45 * DAY).toISOString());
    const row = w.db.store['portal_links']!.at(-1)!;
    expect(Buffer.isBuffer(row['token_sha256']) && row['token_sha256'].length === 32).toBe(true);
    expect(JSON.stringify(w.db.store['portal_links'])).not.toContain(out.url.split('/r/')[1]!);
  });

  it('issuePortalLink is a write for staff/system only: partner and patient actors get auth.forbidden', async () => {
    const w = await world([ver(A, { reportId: R(99), orderId: O(99), releasedAt: isoDay(1) })]);
    for (const key of ['A:partner:p1', 'A:patient:default']) {
      expect((await rejection(w.harness.impl.issuePortalLink(w.harness.ctxFor(key), { reportId: R(99), channel: 'sms', recipientKind: 'patient' }))).code, key).toBe('auth.forbidden');
    }
    expect(w.db.store['portal_links']!.length).toBe(0);
  });
});
