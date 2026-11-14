// C13 T08 — self-check of the fake SQL world used by manifest-drafting.test.ts (so a failing handler test is the handler's fault, not the fake's). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { id, L, M, makeWorld, OR, P, releaseLocks, T_A, USERS } from './manifest-drafting.world.js';

const q = (w: ReturnType<typeof makeWorld>, tx = w.newTx()) => (text: string, vals: unknown[] = []) => tx.query(text, vals);
const MIN = (over: Record<string, unknown> = {}) => ({ id: id(4000), tenant_id: T_A, partner_id: P.x, manifest_no: 'MF26000077', receiving_branch_id: id(10), receiving_centre_id: id(20), conversion_mode: 'on_receipt', created_by: USERS.x1.actor, updated_by: USERS.x1.actor, ...over });
const INS = 'INSERT INTO partners.manifests (id, tenant_id, partner_id, manifest_no, receiving_branch_id, receiving_centre_id, conversion_mode, created_by, updated_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *';
const vals = (o: Record<string, unknown>, notes: unknown = null) => [o['id'], o['tenant_id'], o['partner_id'], o['manifest_no'], o['receiving_branch_id'], o['receiving_centre_id'], o['conversion_mode'], o['created_by'], o['updated_by'], notes];

describe('manifest world self-check', () => {
  it('counter upsert is atomic and per (tenant, partner, yy); new yy starts at 1', async () => {
    const w = makeWorld(); const run = q(w);
    const up = (yy: number, p = P.x) => run('INSERT INTO partners.manifest_counters (tenant_id, partner_id, yy, last_seq, created_by, updated_by) VALUES ($1,$2,$3,1,$4,$4) ON CONFLICT (tenant_id, partner_id, yy) DO UPDATE SET last_seq = partners.manifest_counters.last_seq + 1, updated_at = now() RETURNING last_seq', [T_A, p, yy, USERS.x1.actor]);
    const res = await Promise.all([up(26), up(26), up(26), up(27)]);
    expect(res.map((r) => r.rows[0].last_seq).sort()).toEqual([1, 4, 5, 6]);
    expect(w.counters.find((c) => c['partner_id'] === P.x && c['yy'] === 26)!['last_seq']).toBe(6);
  });

  it('INSERT enforces NOT NULL / CHECK / UNIQUE / unknown column; UPDATE bumps version; guarded columns throw', async () => {
    const w = makeWorld(); const run = q(w); const m = MIN();
    const r = await run(INS, vals(m, 'hello')); expect(r.rows[0]).toMatchObject({ state: 'draft', version: 1, line_count: 0, notes: 'hello' });
    await expect(run(INS, vals(MIN({ id: id(4001) })))).rejects.toMatchObject({ code: '23505', constraint: 'manifests__tenant_id_partner_id_no__uq' }); // same manifest_no
    await expect(run(INS, vals(MIN({ id: id(4002), manifest_no: 'MF2600077' })))).rejects.toMatchObject({ code: '23514' });
    await expect(run(INS, vals(MIN({ id: id(4003), manifest_no: 'MF26000078' }), 'x'.repeat(501)))).rejects.toMatchObject({ code: '23514' });
    await expect(run('INSERT INTO partners.manifests (id, bogus) VALUES ($1,$2)', [id(1), 1])).rejects.toMatchObject({ code: '42703' });
    const u = await run('UPDATE partners.manifests SET notes = $1, version = version + 1, updated_at = now() WHERE tenant_id = $2 AND id = $3 AND version = $4 AND state = \'draft\' RETURNING *', ['n2', T_A, m.id, 1]);
    expect(u.rowCount).toBe(1); expect(u.rows[0]).toMatchObject({ notes: 'n2', version: 2 });
    expect((await run('UPDATE partners.manifests SET notes = $1 WHERE tenant_id = $2 AND id = $3 AND version = $4', ['n3', T_A, m.id, 1])).rowCount).toBe(0); // stale
    await expect(run('UPDATE partners.manifests SET received_at = now() WHERE tenant_id = $1 AND id = $2', [T_A, m.id])).rejects.toMatchObject({ constraint: 'guard_partner_columns' });
    await expect(run('UPDATE partners.manifests SET line_count = line_count - 1 WHERE tenant_id = $1 AND id = $2', [T_A, m.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('SELECT: AND/OR/parens, ANY, IN, IS NULL, LIKE, row compare, ORDER BY, LIMIT, aggregates with alias, count string vs ::int', async () => {
    const w = makeWorld(); const run = q(w);
    expect((await run('SELECT * FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 ORDER BY created_at DESC, id DESC', [T_A, P.x])).rows.map((r) => r.id)).toEqual([M.xs, M.x2, M.x1]);
    expect((await run('SELECT id FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 AND state = ANY($3::text[]) LIMIT $4', [T_A, P.x, ['draft'], 1])).rows).toHaveLength(1);
    expect((await run("SELECT id FROM partners.manifests WHERE tenant_id = $1 AND (state IN ('submitted') OR notes IS NOT NULL) AND partner_id = $2", [T_A, P.x])).rows.map((r) => r.id).sort()).toEqual([M.x1, M.xs].sort());
    expect((await run('SELECT id FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 AND (created_at, id) < ($3::timestamptz, $4::uuid) ORDER BY created_at DESC', [T_A, P.x, '2026-11-03T00:00:00Z', M.xs])).rows.map((r) => r.id)).toEqual([M.x2, M.x1]);
    expect((await run('SELECT COALESCE(MAX(line_no), 0) AS max_no FROM partners.manifest_lines WHERE tenant_id = $1 AND manifest_id = $2', [T_A, M.x1])).rows[0]).toEqual({ max_no: 1 });
    expect((await run('SELECT COALESCE(MAX(line_no), 0) AS max_no FROM partners.manifest_lines WHERE tenant_id = $1 AND manifest_id = $2', [T_A, M.x2])).rows[0]).toEqual({ max_no: 0 });
    expect((await run('SELECT count(*) AS n FROM partners.manifest_lines WHERE tenant_id = $1 AND manifest_id = $2', [T_A, M.x1])).rows[0]).toEqual({ n: '1' });
    expect((await run('SELECT count(*)::int AS n FROM partners.manifest_lines WHERE tenant_id = $1 AND manifest_id = $2', [T_A, M.x1])).rows[0]).toEqual({ n: 1 });
    expect((await run('SELECT orderable_id AS oid, code FROM partners.price_list_items WHERE tenant_id = $1 AND partner_id = $2 AND (lower(code) LIKE $3 OR lower(name) LIKE $3)', [T_A, P.x, 'gluc%'])).rows.map((r) => r.oid)).toEqual([OR.glu]);
    expect((await run('SELECT orderable_id FROM partners.price_list_items WHERE tenant_id = $1 AND partner_id = $2 AND name ILIKE $3', [T_A, P.x, '%THYROID%'])).rows.map((r) => r.orderable_id)).toEqual([OR.tsh]);
    expect((await run('SELECT * FROM partners.settings WHERE tenant_id = $1', [T_A])).rows[0]).toMatchObject({ max_lines_per_manifest: 200, include_default_price_list: true });
    await expect(run('SELECT * FROM partners.manifests m JOIN partners.partners p ON p.id = m.partner_id', [])).rejects.toThrow(/single-table/);
  });

  it('line INSERT: FK to same-partner referrer, UNIQUE line_no / sample ref, jsonb + uuid[] bound params; DELETE removes only the matched row', async () => {
    const w = makeWorld(); const run = q(w);
    const ins = (over: Record<string, unknown>) => run('INSERT INTO partners.manifest_lines (id, tenant_id, partner_id, manifest_id, receiving_centre_id, line_no, partner_sample_ref, patient_full_name, patient_sex, patient_age_years, consent_attested, consent_text_version, orderable_ids, orderables_snapshot, priority, referrer_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid[],$14::jsonb,$15,$16,$17,$17) RETURNING *',
      [over['id'] ?? id(4100), T_A, P.x, M.x2, id(20), over['line_no'] ?? 1, over['ref'] ?? 'R-1', 'Synthetic Patient', 'male', 5, true, 'partner-v1', [OR.glu], JSON.stringify([{ code: 'GLU' }]), 'routine', over['referrer'] ?? null, USERS.x1.actor]);
    const ok = await ins({}); expect(ok.rows[0]).toMatchObject({ line_no: 1, orderables_snapshot: [{ code: 'GLU' }], state: 'draft', version: 1 });
    await expect(ins({ id: id(4101) })).rejects.toMatchObject({ constraint: 'manifest_lines__tenant_id_manifest_id_line_no__uq' });
    await expect(ins({ id: id(4102), line_no: 2 })).rejects.toMatchObject({ constraint: 'manifest_lines__tenant_id_manifest_id_ref__p_uq' });
    await expect(ins({ id: id(4103), line_no: 2, ref: 'R-2', referrer: id(112) })).rejects.toMatchObject({ code: '23503' }); // Y's referrer for X's line
    const d = await run('DELETE FROM partners.manifest_lines WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id', [T_A, id(4100), 1]);
    expect(d.rowCount).toBe(1); expect(w.lines.some((l) => l['id'] === L.x1)).toBe(true);
  });

  it('FOR UPDATE / UPDATE rows are locked until releaseLocks: a second tx waits, then sees the committed state', async () => {
    const w = makeWorld(); const a = w.newTx(), b = w.newTx(); const order: string[] = [];
    await a.query('SELECT * FROM partners.manifests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T_A, M.x1]);
    const pb = b.query('SELECT * FROM partners.manifests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T_A, M.x1]).then((r) => { order.push(`b:v${r.rows[0].version}`); });
    await a.query('UPDATE partners.manifests SET version = version + 1 WHERE tenant_id = $1 AND id = $2', [T_A, M.x1]); order.push('a:updated');
    releaseLocks(a); await pb;
    expect(order).toEqual(['a:updated', 'b:v4']);
  });
});
