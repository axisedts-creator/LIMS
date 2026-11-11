// C6-T21: self-check of the reportingport.helpers.ts fake (so a failing T21 test is never the fake's fault). Passes today; needs no implementation.
import { describe, expect, it } from 'vitest';
import { PAT, P1, P2, id, makeReportingDb, NOW, TENANT_A, TENANT_B } from './reportingport.helpers.js';

const mk = () => {
  const partner = { [id(0x900)]: P1 };
  const w = makeReportingDb(() => NOW, () => partner);
  const t = (n: number) => new Date(Date.parse(NOW) + n * 3600_000).toISOString();
  const vs = [
    { id: id(1), tenant_id: TENANT_A, report_id: id(0x10), version_no: 1, status: 'released', released_at: t(1), partner_id: P1, patient_id: PAT },
    { id: id(2), tenant_id: TENANT_A, report_id: id(0x11), version_no: 1, status: 'released', released_at: t(2), partner_id: P1, patient_id: PAT },
    { id: id(3), tenant_id: TENANT_A, report_id: id(0x12), version_no: 1, status: 'released', released_at: t(2), partner_id: P2, patient_id: PAT },
    { id: id(4), tenant_id: TENANT_A, report_id: id(0x13), version_no: 1, status: 'rendered', released_at: null, partner_id: P1, patient_id: PAT },
    { id: id(5), tenant_id: TENANT_B, report_id: id(0x14), version_no: 1, status: 'released', released_at: t(3), partner_id: P1, patient_id: PAT },
  ];
  for (const v of vs) w.db.insert('report_versions', v);
  for (const v of vs.slice(0, 3)) w.db.insert('qr_tokens', { tenant_id: v.tenant_id, report_id: v.report_id, report_version_id: v.id, panel_names_snapshot: ['X'] });
  return { w, t, staff: w.newTx({ type: 'user', id: id(0x901) }), partnerTx: w.newTx({ type: 'partner', id: id(0x900) }) };
};
const Q = 'SELECT id FROM reporting.report_versions WHERE tenant_id = $1 AND patient_id = $2';

describe('reporting port fake db', () => {
  it('ORDER BY .. LIMIT, row-value keyset comparison in both directions, LIMIT applied after it', async () => {
    const { staff, t } = mk();
    const asc = (await staff.query(`${Q} AND status IN ('released','superseded') ORDER BY released_at, id LIMIT $3`, [TENANT_A, PAT, 10])).rows.map((r: any) => r.id);
    expect(asc).toEqual([id(1), id(2), id(3)]);
    const after = (await staff.query(`${Q} AND (released_at, id) > ($3, $4) ORDER BY released_at, id LIMIT $5`, [TENANT_A, PAT, t(1), id(1), 1])).rows.map((r: any) => r.id);
    expect(after).toEqual([id(2)]);
    const before = (await staff.query(`${Q} AND (released_at, id) < ($3::timestamptz, $4::uuid) ORDER BY released_at DESC, id DESC LIMIT 5`, [TENANT_A, PAT, t(2), id(3)])).rows.map((r: any) => r.id);
    expect(before).toEqual([id(2), id(1)]);
  });

  it('= ANY($n::uuid[]) filters; a missing tenant predicate sees every tenant; the tenant predicate narrows', async () => {
    const { staff } = mk();
    expect((await staff.query('SELECT id FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_version_id = ANY($2::uuid[])', [TENANT_A, [id(1), id(3), id(5)]])).rows.length).toBe(2);
    expect((await staff.query('SELECT id FROM reporting.report_versions WHERE patient_id = $1', [PAT])).rows.length).toBe(5);
    expect((await staff.query('SELECT id FROM reporting.report_versions WHERE tenant_id = $1 AND patient_id = $2', [TENANT_B, PAT])).rows.length).toBe(1);
  });

  it('partner RLS: own partner_id and released/superseded only; qr_tokens follow their version; other tables are default-deny', async () => {
    const { partnerTx, w } = mk();
    expect((await partnerTx.query(`${Q} ORDER BY id`, [TENANT_A, PAT])).rows.map((r: any) => r.id)).toEqual([id(1), id(2)]);
    expect((await partnerTx.query('SELECT report_version_id FROM reporting.qr_tokens WHERE tenant_id = $1', [TENANT_A])).rows.map((r: any) => r.report_version_id).sort()).toEqual([id(1), id(2)]);
    expect((await partnerTx.query('SELECT id FROM reporting.portal_links WHERE tenant_id = $1', [TENANT_A])).rows).toEqual([]);
    const stranger = w.newTx({ type: 'partner', id: id(0x999) });
    expect((await stranger.query(Q, [TENANT_A, PAT])).rows).toEqual([]);
  });

  it('statements are recorded as written', async () => {
    const { staff, w } = mk();
    await staff.query(`${Q} LIMIT $3`, [TENANT_A, PAT, 2]);
    expect(w.reads.at(-1)!.text).toContain('LIMIT $3');
  });
});
