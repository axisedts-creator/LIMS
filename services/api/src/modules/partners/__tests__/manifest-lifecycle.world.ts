// C13 T09 test world: the T08 in-memory SQL world (manifest-drafting.world.ts, same single-table fake SQL subset) plus
//   - guard override: a partner may set manifest_lines.conversion_attempt (MS3 / LS2b: `draft -> converting`, `conversion_attempt = 1`); every other guarded column stays guarded,
//   - ctx.audit.access recorder (audit entries) with an optional failure switch, optional inactive receiving centre,
//   - jobsOf(): decoded app.enqueue_job calls, staffReceive(): a stand-in for the staff receipt (SI3, task T10) that locks the manifest row FIRST (03-APP-FLOW §4.1 M9).
// NOT a test file. Synthetic data only.
import { makeCtx, makeWorld, releaseLocks, T_A, type Over, type Row, type World } from './manifest-drafting.world.js';

export * from './manifest-drafting.world.js';

export function makeWorld9(): World {
  const w = makeWorld();
  const orig = w.guard.bind(w);
  w.guard = (table, cols, values) => orig(table, cols.filter((c) => c !== 'conversion_attempt'), values);
  // partners.g_cs_reasons (05-SCHEMA §7), set manifest_withdraw_reasons: `other` requires text (review item 2).
  const reasons: Row[] = [
    { set_name: 'manifest_withdraw_reasons', code: 'entered_in_error', requires_text: false, is_active: true, sort_order: 1 },
    { set_name: 'manifest_withdraw_reasons', code: 'samples_not_sent', requires_text: false, is_active: true, sort_order: 2 },
    { set_name: 'manifest_withdraw_reasons', code: 'duplicate_manifest', requires_text: false, is_active: true, sort_order: 3 },
    { set_name: 'manifest_withdraw_reasons', code: 'other', requires_text: true, is_active: true, sort_order: 4 },
  ];
  const tables = w.tables.bind(w);
  w.tables = () => ({ ...tables(), 'partners.g_cs_reasons': reasons });
  return w;
}

export interface Over9 extends Over { centreActive?: boolean; auditFails?: boolean }
export function makeCtx9(w: World, over: Over9 = {}) {
  const r = makeCtx(w, over);
  const audit: Array<Record<string, any>> = [];
  r.ctx.audit = { access: async (e: Record<string, any>) => { if (over.auditFails) throw new Error('audit unavailable'); audit.push(e); } };
  if (over.centreActive === false) {
    const centre = r.ctx.core.centre; const centres = r.ctx.core.centres;
    r.ctx.core.centre = async (c: unknown, i: { centreId: string }) => ({ ...(await centre(c, i)), isActive: false });
    r.ctx.core.centres = async (...a: unknown[]) => (await centres(...a)).map((x: Row) => ({ ...x, isActive: false }));
  }
  return { ...r, audit };
}

/** app.enqueue_job calls decoded by shape (the writer may pass the task name as a literal or a bound value). */
export function jobsOf(w: World): Array<{ task: string | undefined; payload: Row | undefined; key: string | undefined }> {
  return (w.jobs as Array<{ text: string; vals: unknown[] }>).map(({ text, vals }) => {
    const strs = vals.filter((v): v is string => typeof v === 'string');
    const task = /'(partners\.[a-z_]+)'/.exec(text)?.[1] ?? strs.find((s) => /^partners\.[a-z_]+$/.test(s));
    const rawPayload = strs.find((s) => s.startsWith('{')); const key = strs.find((s) => s.startsWith('convert:'));
    return { task, payload: rawPayload ? JSON.parse(rawPayload) : undefined, key };
  });
}

/** Staff receipt stand-in: lock the manifest row FIRST, then move submitted lines to converting. `startAfter` = microtask ticks before it begins (interleaving sweep). */
export async function staffReceive(w: World, manifestId: string, startAfter = 0): Promise<'received' | 'conflict'> {
  for (let i = 0; i < startAfter; i++) await Promise.resolve();
  const tx = w.newTx();
  try {
    const { rows } = await tx.query('SELECT id, state, version FROM partners.manifests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T_A, manifestId]);
    if (!rows[0] || rows[0].state !== 'submitted') return 'conflict';
    await tx.query("UPDATE partners.manifest_lines SET state = 'converting', conversion_attempt = 1 WHERE tenant_id = $1 AND manifest_id = $2 AND state = 'submitted'", [T_A, manifestId]);
    await tx.query("UPDATE partners.manifests SET state = 'partially_received', version = version + 1 WHERE tenant_id = $1 AND id = $2", [T_A, manifestId]);
    return 'received';
  } finally { releaseLocks(tx); }
}
