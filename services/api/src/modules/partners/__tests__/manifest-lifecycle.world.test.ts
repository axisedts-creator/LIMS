// Self-checks of the T09 world additions (manifest-lifecycle.world.ts): they must hold before the handler tests mean anything. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { CE, jobsOf, makeCtx9, makeWorld9, M, OR, releaseLocks, staffReceive, T_A } from './manifest-lifecycle.world.js';

describe('T09 world self-check', () => {
  it('guard: conversion_attempt is writable (LS2b), order_id / received_by stay guarded (AB11)', async () => {
    const w = makeWorld9(); const tx = w.newTx();
    await tx.query("UPDATE partners.manifest_lines SET conversion_attempt = 1 WHERE tenant_id = $1 AND manifest_id = $2", [T_A, M.x1]);
    expect(w.lines.find((l) => l['manifest_id'] === M.x1)!['conversion_attempt']).toBe(1);
    await expect(tx.query("UPDATE partners.manifest_lines SET order_id = $3 WHERE tenant_id = $1 AND manifest_id = $2", [T_A, M.x1, OR.glu])).rejects.toThrow(/immutable_row/);
    releaseLocks(tx);
  });

  it('jobsOf decodes literal and bound task names, payload and job key', async () => {
    const w = makeWorld9(); const tx = w.newTx();
    await tx.query("SELECT app.enqueue_job('partners.convert_manifest_line', $1::jsonb, $2)", [JSON.stringify({ tenant_id: T_A, line_id: 'l1', attempt: 1 }), 'convert:l1:1']);
    await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['partners.convert_manifest_line', JSON.stringify({ tenant_id: T_A, line_id: 'l2', attempt: 1 }), 'convert:l2:1']);
    expect(jobsOf(w)).toEqual([1, 2].map((n) => ({ task: 'partners.convert_manifest_line', payload: { tenant_id: T_A, line_id: `l${n}`, attempt: 1 }, key: `convert:l${n}:1` })));
  });

  it('staffReceive waits for a held manifest lock, then reports conflict when the manifest is no longer submitted; otherwise moves lines to converting', async () => {
    const w = makeWorld9();
    const holder = w.newTx();
    await holder.query('SELECT id FROM partners.manifests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T_A, M.xs]);
    const r = staffReceive(w, M.xs); let done = false; void r.then(() => { done = true; });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(done).toBe(false);
    w.manifests.find((m) => m['id'] === M.xs)!['state'] = 'withdrawn'; releaseLocks(holder);
    expect(await r).toBe('conflict');
    w.manifests.find((m) => m['id'] === M.xs)!['state'] = 'submitted';
    expect(await staffReceive(w, M.xs)).toBe('received');
    expect(w.lines.find((l) => l['manifest_id'] === M.xs)).toMatchObject({ state: 'converting', conversion_attempt: 1 });
    expect(w.manifests.find((m) => m['id'] === M.xs)).toMatchObject({ state: 'partially_received', version: 5 });
  });

  it('makeCtx9: audit recorder, failing audit, inactive centre', async () => {
    const w = makeWorld9(); const a = makeCtx9(w);
    await a.ctx.audit.access({ action: 'x' }); expect(a.audit).toEqual([{ action: 'x' }]);
    await expect(makeCtx9(w, { auditFails: true }).ctx.audit.access({})).rejects.toThrow();
    const c = makeCtx9(w, { centreActive: false });
    expect((await c.ctx.core.centre(c.ctx, { centreId: CE.a1 })).isActive).toBe(false);
  });
});
