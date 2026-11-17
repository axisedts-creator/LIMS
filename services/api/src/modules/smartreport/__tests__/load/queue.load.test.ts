// C14 T25 — load: review queue query (endpoint 27) at 1x and 10x seed across two tenants (07-SECURITY row 025: "includes queue and build queries"; 02-TRD §11: p95 <= 200 ms, page 50).
// The REAL summaries.repo.listReviewQueue runs against a statement-level emulator of the 10,000-row table. This proves the statement SHAPE the production index
// summaries__tenant_id_status_built_at__idx serves (tenant first, status, built_at order, LIMIT, no body columns) and tenant isolation at 10x; it cannot measure
// PostgreSQL time. The EXPLAIN-on-real-PG assertion lives in repository.integration.test.ts (T02, LIMS_TEST_DATABASE_URL).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listReviewQueue } from '../../repository/summaries.repo.js';
import { TA, TB } from '../t12.fakes.js';

type Row = Record<string, any>;
const uid = (n: number) => `0190c514-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRES = [uid(0xa201), uid(0xa202)];
const PAGE = 50;

function table(perTenant: number): Row[] {
  const out: Row[] = [];
  for (const [tenant, base] of [[TA, 0x1000000], [TB, 0x2000000]] as const) for (let i = 0; i < perTenant; i++) {
    out.push({ id: uid(base + i), tenant_id: tenant, centre_id: CENTRES[i % 2], status: ['draft', 'draft', 'draft', 'draft', 'draft', 'draft', 'draft', 'approved', 'approved', 'superseded'][i % 10],
      built_at: new Date(Date.UTC(2026, 10, 1) + ((i * 7919) % perTenant) * 1000).toISOString(), content_sha256: createHash('sha256').update(`${tenant}${i}`).digest('hex') });
  }
  return out;
}

/** Executes the two statement shapes of listReviewQueue by reading the $n placeholders out of the SQL text the repository really sent. */
function emulator(rows: Row[]) {
  const sent: { text: string; values: unknown[] }[] = [];
  const tx = {
    async query(text: string, values: unknown[] = []) {
      sent.push({ text, values });
      const ph = (re: RegExp): unknown => { const m = re.exec(text); return m ? values[Number(m[1]) - 1] : undefined; };
      const tenant = ph(/tenant_id\s*=\s*\$(\d)/), status = ph(/status\s*=\s*\$(\d)/), centre = ph(/centre_id\s*=\s*\$(\d)/), limit = Number(ph(/LIMIT\s+\$(\d)/));
      if (!/ORDER BY built_at ASC, id ASC/i.test(text)) throw new Error('queue must be ordered oldest-first with an id tiebreak');
      const hit = rows.filter((r) => r.tenant_id === tenant && r.status === status && (centre === undefined || r.centre_id === centre))
        .sort((a, b) => (a.built_at < b.built_at ? -1 : a.built_at > b.built_at ? 1 : a.id < b.id ? -1 : 1));
      return { rows: hit.slice(0, limit) };
    },
  };
  return { tx, sent };
}

describe.each([[1, 500], [10, 5000]] as const)('C14-T25 queue load — %dx seed (%d summaries per tenant, tenants A + B)', (x, perTenant) => {
  const rows = table(perTenant);
  const rc = (tenantId: string, e = emulator(rows)) => ({ rc: { tx: e.tx, tenantId, actorId: uid(0x7777) }, e });

  it('draft queue page: 50 oldest drafts of the caller tenant, in built_at order, never a row of the other tenant', async () => {
    for (const tenant of [TA, TB]) {
      const { rc: c } = rc(tenant);
      const page = await listReviewQueue(c, { status: 'draft', limit: PAGE });
      expect(page).toHaveLength(PAGE);
      expect(page.every((r) => r.tenant_id === tenant && r.status === 'draft')).toBe(true);
      expect(page.map((r) => r.built_at)).toEqual([...page.map((r) => r.built_at)].sort());
      const oldest = rows.filter((r) => r.tenant_id === tenant && r.status === 'draft').map((r) => r.built_at).sort()[0];
      expect(page[0]!.built_at).toBe(oldest);
    }
  });

  it('centre filter keeps the tenant filter (centre ids are not globally unique evidence)', async () => {
    const { rc: c, e } = rc(TA);
    const page = await listReviewQueue(c, { status: 'draft', centreId: CENTRES[0]!, limit: PAGE });
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((r) => r.tenant_id === TA && r.centre_id === CENTRES[0])).toBe(true);
    expect(e.sent[0]!.values[0]).toBe(TA);
  });

  it('statement shape served by summaries__tenant_id_status_built_at__idx: tenant bound first, schema-qualified, status + ORDER BY built_at, LIMIT bound, no body columns', async () => {
    for (const q of [{ status: 'draft' }, { status: 'approved', centreId: CENTRES[1]! }]) {
      const { rc: c, e } = rc(TB);
      await listReviewQueue(c, { ...q, limit: PAGE });
      const { text, values } = e.sent[0]!;
      expect(text).toMatch(/FROM smartreport\.summaries WHERE tenant_id = \$1\b/);
      expect(text).toMatch(/status = \$\d/);
      expect(text).toMatch(/LIMIT \$\d/);
      expect(values[0]).toBe(TB);
      expect(values).toContain(PAGE);
      const select = /SELECT (.*?) FROM/s.exec(text)![1]!;
      expect(select).not.toMatch(/\*/);
      expect(select).not.toMatch(/(^|[\s,])(content|llm_overlay|input_result_versions)([\s,]|$)/);   // P3 bodies are loaded on open, not listed
    }
  });

  it('one statement per page (no per-row follow-up queries) and the page size is bounded', async () => {
    const { rc: c, e } = rc(TA);
    await listReviewQueue(c, { status: 'draft', limit: PAGE });
    expect(e.sent).toHaveLength(1);
    await listReviewQueue(c, { status: 'draft', limit: 1_000_000 });
    expect(e.sent[1]!.values.at(-1)).toBeLessThanOrEqual(1000);
    console.log(`[T25 ${x}x] queue: 1 statement/page, tenant-first, LIMIT bound (page ${PAGE}) over ${rows.length} rows`);
  });
});
