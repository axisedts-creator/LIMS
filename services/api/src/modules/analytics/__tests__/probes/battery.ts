// AN-T21 probe battery (not a test file): the cross-tenant / cross-centre checks P1, P3, P4, P5, X3 applied to a list of report operations over a seeded "world"
// (a set of the AN-T08..T14 emulators). Each *.probe.test.ts file picks a world, registers the vi.mock()s of that world, and calls runReportBattery().
// Query parameters are generated from analytics.yaml (date window only when the operation declares one), never hard-coded per operation.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { OPS, extraPaths, type Op } from './spec.js';

export interface Actors { all: string; a1: string }
export interface World {
  name: string;
  seed(): void;
  makeCtx(actorKey: string): Promise<{ ctx: any }>;
  actorsFor(o: Op): Actors;
  window: Record<string, string>;
  centres: { a1: string; a2: string; b: string };
  branches: { containsA1andA2: string; b: string };
  /** strings (tenant B ids / names / sentinels) that must never appear in any body or error */
  forbidden: readonly string[];
  extraQuery?(o: Op): Record<string, unknown>;
  /** pending world: unfiltered reads include items received at the caller's centres (C5 RLS, D-49) */
  receivedAtCentres?: boolean;
  foreignDepartment?: string; homeDepartment?: string;
}

export async function callOp(o: Op, ctx: any, query: Record<string, unknown>, body?: unknown): Promise<any> {
  const { handlers } = await import('../../handlers/index.js');
  ctx.operationId = o.id;
  return (handlers as Record<string, any>)[o.id]({ params: {}, query, headers: { 'idempotency-key': 'k21-battery' }, body }, ctx);
}
const settle = (p: Promise<any>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
/** Body without the fields that legitimately differ between two callers (echoed scope, clock). */
const data = (b: any): string => JSON.stringify(b, (k, v) => (k === 'scope' || k === 'generated_at' ? undefined : v));

export function runReportBattery(w: World, opIds: readonly string[]): void {
  const ops = opIds.map((id) => OPS.find((o) => o.id === id) ?? (() => { throw new Error(`unknown op ${id}`); })());
  describe.each(ops.map((o) => [o.id, o] as const))(`${w.name}: %s`, (_id, o) => {
    const query = (extra: Record<string, unknown> = {}) => ({ ...(o.query.includes('business_date_from') ? w.window : {}), ...(w.extraQuery?.(o) ?? {}), ...extra });
    const run = async (actor: string, q: Record<string, unknown>) => { w.seed(); const { ctx } = await w.makeCtx(actor); return settle(callOp(o, ctx, q)); };
    const hasCentre = o.query.includes('centre_id'), hasBranch = o.query.includes('branch_id');
    const noLeak = (r: Awaited<ReturnType<typeof run>>) => {
      const text = r.ok ? JSON.stringify(r.v) : JSON.stringify({ m: (r.e as Error)?.message, d: (r.e as any)?.detail, errors: (r.e as any)?.errors });
      for (const s of w.forbidden) expect(text, `tenant B value ${s}`).not.toContain(s);
    };

    it('baseline: all-centre caller gets 200 and no tenant B value anywhere in the body', async () => {
      const r = await run(w.actorsFor(o).all, query());
      expect(r.ok, JSON.stringify(r.ok ? '' : (r.e as any)?.code ?? String(r.e))).toBe(true);
      if (r.ok) { expect(r.v.status).toBe(200); noLeak(r); }
    });

    it('X3: the body carries no key the response schema does not declare', async () => {
      const r = await run(w.actorsFor(o).all, query());
      if (r.ok) expect(extraPaths(o.id, r.v.body)).toEqual([]);
    });

    (hasCentre ? it : it.skip)('P1: tenant B centre_id (alone or mixed with a tenant A centre) -> 404 common.not_found, no tenant B value in the error', async () => {
      for (const ids of [[w.centres.b], [w.centres.a1, w.centres.b]]) {
        const r = await run(w.actorsFor(o).all, query({ centre_id: ids }));
        expect(r.ok, `centre_id=${JSON.stringify(ids)} answered`).toBe(false);
        if (!r.ok) { expect(isLimsError(r.e, 'common.not_found')).toBe(true); expect((r.e as any).statusCode).toBe(404); }
        noLeak(r);
      }
    });

    (hasBranch ? it : it.skip)('P1: tenant B branch_id (alone or mixed) -> 404 common.not_found', async () => {
      for (const ids of [[w.branches.b], [w.branches.containsA1andA2, w.branches.b]]) {
        const r = await run(w.actorsFor(o).all, query({ branch_id: ids }));
        expect(r.ok, `branch_id=${JSON.stringify(ids)} answered`).toBe(false);
        if (!r.ok) expect(isLimsError(r.e, 'common.not_found')).toBe(true);
        noLeak(r);
      }
    });

    (o.query.includes('processing_branch_id') ? it : it.skip)('P1: tenant B processing_branch_id -> 404 common.not_found', async () => {
      for (const ids of [[w.branches.b], [w.branches.containsA1andA2, w.branches.b]]) {
        const r = await run(w.actorsFor(o).all, query({ processing_branch_id: ids }));
        expect(r.ok, `processing_branch_id=${JSON.stringify(ids)} answered`).toBe(false);
        if (!r.ok) expect(isLimsError(r.e, 'common.not_found')).toBe(true);
        noLeak(r);
      }
    });

    (o.query.includes('department_id') && w.foreignDepartment ? it : it.skip)('P1: tenant B department_id (alone or mixed) -> 404 common.not_found', async () => {
      for (const ids of [[w.foreignDepartment!], [w.homeDepartment!, w.foreignDepartment!]]) {
        const r = await run(w.actorsFor(o).all, query({ department_id: ids }));
        expect(r.ok, `department_id=${JSON.stringify(ids)} answered`).toBe(false);
        if (!r.ok) expect(isLimsError(r.e, 'common.not_found')).toBe(true);
        noLeak(r);
      }
    });

    (hasCentre ? it : it.skip)('P3: A1-only caller: centre_id=A2 -> 404 (no oracle); unfiltered result equals an all-centre caller filtered to A1 (NULL-centre rows absent, P4)', async () => {
      const foreign = await run(w.actorsFor(o).a1, query({ centre_id: [w.centres.a2] }));
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(isLimsError(foreign.e, 'common.not_found')).toBe(true);
      // receivedAtCentres (D-49 / D-C8-08): an unfiltered pending read also shows items RECEIVED at the caller's centres, so only the explicit-filter forms must agree.
      const scoped = await run(w.actorsFor(o).a1, query(w.receivedAtCentres ? { centre_id: [w.centres.a1] } : {}));
      const wide = await run(w.actorsFor(o).all, query({ centre_id: [w.centres.a1] }));
      expect(scoped.ok && wide.ok).toBe(true);
      if (scoped.ok && wide.ok) {
        expect(data(scoped.v.body)).toBe(data(wide.v.body));
        const sc = scoped.v.body.scope;
        if (sc) { expect(sc.all_centres).toBe(false); expect(sc.centre_ids).toEqual([w.centres.a1]); expect(sc.tenant_wide_sections_hidden).toEqual([]); }
      }
    });

    (hasBranch ? it : it.skip)('P5: a branch containing A1 and A2 does not widen an A1-only caller (result unchanged, scope stays {A1})', async () => {
      const plain = await run(w.actorsFor(o).a1, query(w.receivedAtCentres ? { centre_id: [w.centres.a1] } : {}));
      const viaBranch = await run(w.actorsFor(o).a1, query({ branch_id: [w.branches.containsA1andA2] }));
      const why = (r: typeof plain) => (r.ok ? 'ok' : `${(r.e as any)?.code ?? r.e}`);
      expect(plain.ok && viaBranch.ok, `plain=${why(plain)} viaBranch=${why(viaBranch)}`).toBe(true);
      if (plain.ok && viaBranch.ok) {
        expect(data(viaBranch.v.body)).toBe(data(plain.v.body));
        if (viaBranch.v.body.scope) expect(viaBranch.v.body.scope.centre_ids).toEqual([w.centres.a1]);
      }
    });
  });
}
