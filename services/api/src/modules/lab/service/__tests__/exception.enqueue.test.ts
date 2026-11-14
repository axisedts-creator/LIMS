// C5 T-23 — AC-04.5 "auto reapply on receive": the receive transaction enqueues `lab.reapply_exceptions_for_specimen` with job_key = specimen_id (02-TRD §8; PRD AC-04.5). No database.
// SEAM: service/exception.service.ts exports `enqueueReapplyForSpecimen(ctx: { tx, tenantId }, specimenId): Promise<void>` = ONE `SELECT app.enqueue_job($1, $2::jsonb, $3, ...)` on ctx.tx
//   with params [ 'lab.reapply_exceptions_for_specimen', JSON.stringify({ tenant_id, specimen_id }), specimen_id ] (ids only: the barcode is patient-linked and is looked up by the task).
//   specimen.service.ts calls it inside the receive transaction (single receive #7 and bulk receive #8 share the S4 step), so a rollback of the receive drops the job too (enqueue_job runs on ctx.tx).
// The end-to-end effect (exception applied after the receive) is proven by tasks.reapply.test.ts in the worker; the wiring into specimen.service.ts is pinned statically here because the
// receive path is SQL-bound (its DB behaviour is covered by handlers/__tests__/specimen.handlers.integration.test.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { enqueueReapplyForSpecimen } from '../exception.service.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const SPEC = '01a1a98a-ac40-7000-8000-0000000e0001';

describe('T-23 enqueueReapplyForSpecimen', () => {
  it('issues exactly one app.enqueue_job on the request tx: task id, ids-only payload, job_key = specimen_id', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx = { async query(sql: string, params: unknown[]) { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
    await enqueueReapplyForSpecimen({ tx, tenantId: A } as never, SPEC);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/app\.enqueue_job/);
    expect(calls[0]!.params[0]).toBe('lab.reapply_exceptions_for_specimen');
    expect(JSON.parse(calls[0]!.params[1] as string)).toEqual({ tenant_id: A, specimen_id: SPEC });
    expect(calls[0]!.params[2]).toBe(SPEC);
  });
  it('a failing enqueue propagates (the receive rolls back; no half-received specimen without its follow-up job)', async () => {
    const tx = { async query() { throw new Error('enqueue failed'); } };
    await expect(enqueueReapplyForSpecimen({ tx, tenantId: A } as never, SPEC)).rejects.toThrow('enqueue failed');
  });
  it('the tenant is the ctx tenant only; a missing tenant is refused before any query', async () => {
    let n = 0;
    const tx = { async query() { n++; return { rows: [] }; } };
    await expect(enqueueReapplyForSpecimen({ tx, tenantId: undefined } as never, SPEC)).rejects.toBeDefined();
    expect(n).toBe(0);
  });
});

describe('T-23 receive path wiring (static)', () => {
  const src = readFileSync(fileURLToPath(new URL('../specimen.service.ts', import.meta.url)), 'utf8');
  it('specimen.service.ts imports and calls enqueueReapplyForSpecimen in the receive step (S4), not in a separate request', () => {
    expect(src).toMatch(/import[^;]*enqueueReapplyForSpecimen[^;]*exception\.service/);
    const at = src.indexOf("if (a.kind === 'receive') {");
    expect(at, 'receive branch of the transition step not found').toBeGreaterThan(-1);
    expect(src.slice(at, at + 1500)).toMatch(/enqueueReapplyForSpecimen\(/);
  });
});
