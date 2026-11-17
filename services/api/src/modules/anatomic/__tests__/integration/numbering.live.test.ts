// C11.T-06 LIVE integration (gated exactly like T-04: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL point at a migrated DB incl. the anatomic DDL).
// Proves what the in-memory unit tests cannot: row-lock concurrency (AC-02.2, plan: "20 parallel accessions distinct+consecutive"), year rollover on the real counter
// table (AC-02.4), and the real unique index (tenant_id, accession_no) → 409 anatomic.accession_duplicate (AC-02.6). Real handlers, real repositories, real requestTx.
// All fixture rows use ids 0190c411-… and counters in year_ad 2199 (setup.ts YEAR; `now` below is in 2199 NPT so the number renders S99-NNNN) and are removed by cleanup().
// Same ctx assumption as ../accession.service.test.ts. Not run here: no PG in this environment and no anatomic DDL in db/migrations yet (see T-04 notes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { caseRow, CENTRE_A1, CLAIMS, LIVE, openHarness, partRow, SYS, TENANT_A, uid, YEAR, type Harness } from './setup.js';

const NOW_2199 = new Date('2199-06-01T06:00:00Z'), NOW_NEXT_YEAR = new Date('2199-12-31T18:15:00Z'); // 2199-12-31 18:15Z = 1 Jan 2200 NPT (counter year 2200 is outside the cleanup)
const ctxFor = (tx: unknown, now: Date, numbering: Record<string, unknown> = {}) => ({
  operationId: 'accessionAnatomicCase', clientIp: '203.0.113.7', log: { info() {}, warn() {}, error() {} },
  tenantId: TENANT_A, actor: { type: 'user', id: CLAIMS.allA.sub }, tx, now: () => now,
  core: { async branch() { throw new Error('unused'); } },
  ports: { IdentityPort: { async assertRole() {}, async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering }; } } },
}) as any;

describe.skipIf(!LIVE)('C11-T06 accession over a real DB', () => {
  let h: Harness;
  beforeAll(async () => { h = await openHarness(); await h.cleanup(); });
  afterAll(async () => {
    if (h) {
      await h.cleanup().catch(() => undefined);
      await h.asSuperuser((tx) => tx.query(`DELETE FROM anatomic.accession_counters WHERE year_ad = 2200`)).catch(() => undefined);
      await h.close();
    }
  });

  const seedCase = async (n: number, over: Record<string, unknown> = {}) => {
    const c = caseRow(uid(1100 + n), TENANT_A, CENTRE_A1, { created_by: SYS, ...over });
    await h.seed('anatomic.cases', c);
    await h.seed('anatomic.parts', partRow(uid(1200 + n), c['id'] as string, TENANT_A, CENTRE_A1));
    return { caseId: c['id'] as string, partId: uid(1200 + n) };
  };
  const accession = (caseId: string, partId: string, now: Date, numbering?: Record<string, unknown>, version = 1) =>
    h.asApp(CLAIMS.allA, (tx) => (manifest.handlers as any)['accessionAnatomicCase'](
      { params: { case_id: caseId }, query: {}, headers: { 'if-match': `"${version}"` }, body: { parts: [{ part_id: partId, site_text: 'Left breast' }] } }, ctxFor(tx, now, numbering)));

  it('AC-02.2: 20 parallel accessions (20 separate transactions) → 20 distinct, consecutive numbers S99-0001…S99-0020', async () => {
    const cases = await Promise.all(Array.from({ length: 20 }, (_, i) => seedCase(i + 1)));
    const rs = await Promise.all(cases.map((c) => accession(c.caseId, c.partId, NOW_2199)));
    const nos = rs.map((r: any) => r.body.accession_no as string).sort();
    expect(new Set(nos).size).toBe(20);
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => `S99-${String(i + 1).padStart(4, '0')}`));
    const { rows } = await h.asSuperuser((tx) => tx.query(`SELECT last_value FROM anatomic.accession_counters WHERE tenant_id = $1 AND series_key = 'histology' AND year_ad = $2`, [TENANT_A, YEAR]));
    expect(Number(rows[0].last_value)).toBe(20);
  }, 60_000);

  it('A6: two parallel addAnatomicPart on one case (own transactions) → letters B and C, both 201, no 409/500 (case row lock serialises)', async () => {
    const c = await seedCase(20, { status: 'accessioned', accession_no: 'S99-9020' }); // seeded part is letter A
    const add = (site: string) => h.asApp(CLAIMS.allA, (tx) => (manifest.handlers as any)['addAnatomicPart'](
      { params: { case_id: c.caseId }, query: {}, headers: {}, body: { site_text: site } }, ctxFor(tx, NOW_2199)));
    const rs: any[] = await Promise.all([add('left'), add('right')]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(rs.map((r) => r.body.letter).sort()).toEqual(['B', 'C']);
    const { rows } = await h.asSuperuser((tx) => tx.query(`SELECT letter, letter_seq FROM anatomic.parts WHERE case_id = $1 ORDER BY letter_seq`, [c.caseId]));
    expect(rows.map((r: any) => r.letter)).toEqual(['A', 'B', 'C']);
  }, 30_000);

  it('AC-02.4: first accession of the new tenant-timezone year restarts at 1 for that series (counter row year 2200)', async () => {
    const c = await seedCase(30);
    const r: any = await accession(c.caseId, c.partId, NOW_NEXT_YEAR);
    expect(r.body.accession_no).toBe('S00-0001'); // 2200 % 100
  });

  it('AC-02.3: overflow rolls the whole transaction back (counter value and case unchanged)', async () => {
    await h.asSuperuser((tx) => tx.query(`UPDATE anatomic.accession_counters SET last_value = 9999 WHERE tenant_id = $1 AND series_key = 'histology' AND year_ad = $2`, [TENANT_A, YEAR]));
    const c = await seedCase(31);
    const e: unknown = await accession(c.caseId, c.partId, NOW_2199).then(() => undefined, (x) => x);
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
    const { rows } = await h.asSuperuser((tx) => tx.query(`SELECT c.status, c.accession_no, k.last_value FROM anatomic.cases c, anatomic.accession_counters k WHERE c.id = $1 AND k.tenant_id = $2 AND k.series_key = 'histology' AND k.year_ad = $3`, [c.caseId, TENANT_A, YEAR]));
    expect(rows[0]).toMatchObject({ status: 'received', accession_no: null });
    expect(Number(rows[0].last_value)).toBe(9999);
  });

  it('AC-02.6: pattern without {yy}, counter reset while the number exists → 409 anatomic.accession_duplicate from the real unique index; rolled back', async () => {
    const numbering = { accessionNoPattern: '{prefix}-{seq:4}' };
    const a = await seedCase(40), b = await seedCase(41);
    expect(((await accession(a.caseId, a.partId, NOW_2199, numbering)) as any).body.accession_no).toBe('S-0001');
    await h.asSuperuser((tx) => tx.query(`UPDATE anatomic.accession_counters SET last_value = 0 WHERE tenant_id = $1 AND series_key = 'histology' AND year_ad = 0`, [TENANT_A]));
    const e: any = await accession(b.caseId, b.partId, NOW_2199, numbering).then(() => undefined, (x) => x);
    expect(isLimsError(e, 'anatomic.accession_duplicate')).toBe(true);
    const { rows } = await h.asSuperuser((tx) => tx.query(`SELECT status FROM anatomic.cases WHERE id = $1`, [b.caseId]));
    expect(rows[0].status).toBe('received');
    await h.asSuperuser((tx) => tx.query(`DELETE FROM anatomic.accession_counters WHERE tenant_id = $1 AND year_ad = 0`, [TENANT_A]));
  });
});
