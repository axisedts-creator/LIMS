// billing.export_tenant (02-TRD §7.2 row, §13; 04 D16 / B17). MANUAL task for ONE tenant, run under that tenant's claims (support session / runbook).
// READ-ONLY: reads every billing table that has a tenant_id column (FK order, rows by primary key) through ctx.tx and stores ONE encrypted archive
// in bucket `billing-exports` under `<tenant_id>/…` (first path segment = tenant, 07-SECURITY). Restore = docs/manual/billing/tenant-export.md.
// [CONV] archive = "LBX1" | iv(12) | GCM tag(16) | AES-256-GCM(JSON {manifest, rows}); key = env LIMS_BILLING_EXPORT_KEY (base64, 32 bytes); "LBX1" is the AAD.
// [CONV] manifest.tables[i].sha256 = hex SHA-256 of the table's rows, each JSON.stringify(row_to_json) on its own line, ordered by primary key.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { TaskHandler } from '../../../core/manifest.js';

export const EXPORT_TENANT = 'billing.export_tenant';
const MAGIC = Buffer.from('LBX1');
const BUCKET = 'billing-exports';
const IDENT = /^[a-z_][a-z0-9_]*$/;

type TableEntry = { table: string; row_count: number; sha256: string };
type Archive = { manifest: { tenant_id: string; tables: TableEntry[] }; rows: Record<string, Array<Record<string, unknown>>> };

const sha256 = (rows: unknown[]) => createHash('sha256').update(rows.map((r) => JSON.stringify(r)).join('\n')).digest('hex');

function keyOf(keyBase64: string | undefined): Buffer {
  const key = Buffer.from(keyBase64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('LIMS_BILLING_EXPORT_KEY must be base64 of 32 bytes');
  return key;
}

/** Decrypt + verify an archive. Throws on a wrong key, any modified/truncated byte, or a manifest that does not match the rows. */
export function openArchive(bytes: Uint8Array, keyBase64: string): Archive {
  const buf = Buffer.from(bytes);
  if (buf.length < MAGIC.length + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a billing tenant archive');
  const d = createDecipheriv('aes-256-gcm', keyOf(keyBase64), buf.subarray(4, 16));
  d.setAAD(MAGIC);
  d.setAuthTag(buf.subarray(16, 32));
  const archive = JSON.parse(Buffer.concat([d.update(buf.subarray(32)), d.final()]).toString('utf8')) as Archive;
  for (const t of archive.manifest.tables) {
    const rows = archive.rows[t.table] ?? [];
    if (rows.length !== t.row_count || sha256(rows) !== t.sha256) throw new Error(`archive manifest mismatch for ${t.table}`);
  }
  return archive;
}

/** parents before children; edges between different tables only; ties by name (deterministic) */
function fkOrder(tables: string[], edges: Array<{ child: string; parent: string }>): string[] {
  const left = new Set(tables), out: string[] = [];
  while (left.size) {
    const ready = [...left].sort().filter((t) => !edges.some((e) => e.child === t && e.parent !== t && left.has(e.parent)));
    if (!ready.length) throw new Error('billing FK cycle between tables');
    for (const t of ready) { out.push(t); left.delete(t); }
  }
  return out;
}

export const exportTenant: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'export_tenant_skipped', reason: 'bad_payload' });
    return;
  }
  const key = keyOf(process.env['LIMS_BILLING_EXPORT_KEY']);
  const q = (sql: string, v: unknown[] = []) => ctx.tx.query(sql, v) as Promise<{ rows: any[] }>;

  const tables: string[] = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`)).rows.map((r) => r.relname);
  for (const t of tables) if (!IDENT.test(t)) throw new Error(`unexpected billing table name ${t}`);
  const edges = (await q(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'billing'::regnamespace AND c.conrelid <> c.confrelid`)).rows
    .map((r) => ({ child: String(r.child).replace(/^billing\./, ''), parent: String(r.parent).replace(/^billing\./, '') }));
  const pks = (await q(`SELECT c.relname AS t, a.attname AS col FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'billing' AND i.indisprimary ORDER BY c.relname, k.ord`)).rows;

  const manifest: Archive['manifest'] = { tenant_id: tenantId, tables: [] };
  const rows: Archive['rows'] = {};
  for (const t of fkOrder(tables, edges)) {
    const order = pks.filter((p) => p.t === t).map((p) => `x."${p.col}"`).join(', ') || 'x::text';   // ponytail: no-PK table falls back to text order
    rows[t] = (await q(`SELECT row_to_json(x) AS r FROM billing."${t}" x WHERE x.tenant_id = $1 ORDER BY ${order}`, [tenantId])).rows.map((r) => r.r);
    manifest.tables.push({ table: t, row_count: rows[t]!.length, sha256: sha256(rows[t]!) });
  }

  // ponytail: whole archive in memory; stream per table if a tenant's billing data outgrows that.
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(JSON.stringify({ manifest, rows }), 'utf8'), c.final()]);
  const bytes = new Uint8Array(Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]));
  const stamp = String(ctx.now()).replace(/[^0-9TZ]/g, '');
  await ctx.storage.put(BUCKET, `${tenantId}/tenant-export/${stamp}-${randomBytes(4).toString('hex')}.lbx`, bytes, { contentType: 'application/octet-stream', ifAbsent: true });
  ctx.log?.info?.({ event: 'export_tenant_done', tables: manifest.tables.length });
};
