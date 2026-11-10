// BL-T22 / 07-SECURITY §6.1 cross-tenant probes — every C4 operation (F1–F26 incl. F8b/F21a = 29 frontdesk ops; B1–B37 incl. B10a–c/B29a = 47 billing ops).
// Given tenant A authenticated with the operation's permission, When it calls the handler with tenant-B ids (path / query / body incl. arrays and catalog ids),
// Then the answer is 404 common.not_found (validation_failed only for catalog ids), no B data in the answer, and the DB only ever sees tenant A's id.
// "RLS-faithful" fake tx: every table read is empty (B's rows are invisible), every statement is recorded. Ports refuse B ids with common.not_found (§6.1 "Port probes").
// Fails now (right reason): FD-T01 / BL-T01 stubs throw common.service_unavailable; the implemented billing handlers are held to the same standard.
// NOT covered (needs a live pg with seeded tenants/centres; no generic seed exists): "DB check as owner shows zero b changes", §6.2 cross-centre probes, consumer probes (b envelopes -> only b rows) — see notes.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { ALL_OPS, B_ID, ctxFor, run, requestFor, spyTx, TENANT_A, TENANT_B, safeJson } from './probe.kit.js';

const CATALOG_ID_OPS = new Set(['createRegistration', 'quoteRegistration', 'quoteOrderItemsChange', 'changeOrderItems']);
const tableStmt = (text: string) => /\b(billing|frontdesk)\.[a-z_]+/i.test(text);

describe('registry', () => {
  it('covers all 29 frontdesk and 47 billing operations', () => {
    expect(ALL_OPS.filter((o) => o.mod === 'frontdesk')).toHaveLength(29);
    expect(ALL_OPS.filter((o) => o.mod === 'billing')).toHaveLength(47);
  });
});

describe.each(ALL_OPS.map((o) => [`${o.mod}:${o.id}`, o] as const))('%s', (_n, o) => {
  const byId = o.pathParams.some((p) => p.endsWith('_id'));
  const sent = requestFor(o);
  const bodyNamesB = safeJson(sent.body ?? null).includes(B_ID);
  const mustRefuse = byId || bodyNamesB;
  const isList = o.isList && !byId;

  it('never leaks tenant B and never reaches the DB without tenant A\'s id', async () => {
    const { tx, stmts } = spyTx();
    const { result, error } = await run(o, await ctxFor(TENANT_A, tx));
    expect(error === undefined || error instanceof LimsError, `non-LimsError thrown: ${error?.stack ?? error}`).toBe(true);
    const seen = safeJson(result ?? { code: error?.code, detail: error?.detail, errors: error?.errors });
    expect(seen).not.toContain(B_ID);
    expect(seen).not.toContain(TENANT_B);
    for (const s of stmts.filter((x) => tableStmt(x.text))) {
      expect(s.values, s.text).toContain(TENANT_A);
      expect(s.values, s.text).not.toContain(TENANT_B);
    }
  });

  if (mustRefuse) {
    it('B ids in path/body => 404 common.not_found' + (CATALOG_ID_OPS.has(o.id) ? ' (or common.validation_failed for a B-only catalog item)' : ''), async () => {
      const { tx } = spyTx();
      const { result, error } = await run(o, await ctxFor(TENANT_A, tx));
      expect(result, `answered ${result?.status}; B objects must be invisible`).toBeUndefined();
      expect(error, 'expected a LimsError').toBeInstanceOf(LimsError);
      // validation_failed only where the B id travels in the body (catalog ids, party/branch ids) — never for a B id in the path
      expect(!byId || CATALOG_ID_OPS.has(o.id) ? ['common.not_found', 'common.validation_failed'] : ['common.not_found']).toContain(error.code);
    });
  } else if (isList || o.id === 'searchPatients') { // settings / registers / daily cash are tenant-level reads: covered by the no-leak test above
    it('with only B data present => 200 and zero rows (no B row, no B count)', async () => {
      const { tx } = spyTx();
      const { result, error } = await run(o, await ctxFor(TENANT_A, tx), requestFor(o, { query: {} }));
      expect(error, `refused with ${error?.code}`).toBeUndefined();
      expect(result.status).toBe(200);
      if (Array.isArray(result.body?.data)) expect(result.body.data).toHaveLength(0);
    });
  }
});

describe('arrays of B ids refuse before any write (a+b mixes need a live DB, not covered)', () => {
  // bodies carry arrays of ids (trf_attachment_ids, items[].orderable_id, lines[].invoice_line_id, resolves_task_ids); the sample builder fills every id with a B id
  for (const id of ['uploadTrf', 'createRegistration', 'changeOrderItems', 'issuePartialCreditNote', 'resolveOrderFlag']) it(`${id} exists in the registry and writes nothing for tenant A when any id belongs to B`, async () => {
    const o = ALL_OPS.find((x) => x.id === id)!;
    expect(o, id).toBeDefined();
    const { tx, stmts } = spyTx();
    const { result, error } = await run(o, await ctxFor(TENANT_A, tx));
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(LimsError);
    expect(stmts.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text) && tableStmt(s.text)), 'no write before the B id was refused').toEqual([]);
  });
});
