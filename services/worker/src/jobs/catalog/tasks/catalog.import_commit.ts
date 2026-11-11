// catalog.import_commit for kind `price_list` (02-TRD §8.5, §10): ONE transaction (ctx.tx): lock the import (status `committing` is the only working state;
// anything else is a duplicate/redelivery -> no-op) -> re-validate the stored sheet against the CURRENT catalog -> open draft? (commit_failed + file.draft_exists,
// or discard it when the payload says replace_draft === true) -> apply through the API pricing service (draft -> items -> publish) as imports.committed_by
// (actor-on-behalf) -> `committed`. A failed commit RESOLVES (the commit_failed state must persist); a crash THROWS (everything rolls back, the retry re-runs).
// Kinds catalog_master / referrers / credit_parties (T-25): the same planner as the validation re-validates, open drafts of the targets it versions ->
// file.draft_exists (or discarded with replace_draft), apply() as committed_by, then ONE bumpRevision (`catalog_import`, D-21) and the touched orderables are
// stamped with that revision. No cell value is ever stored in an issue or logged (07 S-13).
import { loadCatalogConfig } from '../../../../../api/src/modules/catalog/config.js';
import { createPricingService } from '../../../../../api/src/modules/catalog/service/pricing.service.js';
import { createRevisionService } from '../../../../../api/src/modules/catalog/service/revision.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { XlsxReadError, readXlsx } from '../xlsx/XlsxReader.js';
import { KINDS, planKind, type Writer } from './catalog.import_kinds.js';
import { CODE_RE, FILE_SHEET, MSG, blank, parsePrice, sev, txt } from './catalog.import_validate.js';

export const IMPORT_COMMIT = 'catalog.import_commit';

const KNOWN_COLS = ['orderable_code', 'orderable_kind', 'unit_price_npr'];
const CHUNK = 400;      // issue rows per INSERT (12 binds each)
const BATCH = 200;      // pricing.service bulk limit
const DRAFT_MSG = 'The price list already has an open draft version; discard it or commit with replace_draft.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Issue { sheet: string; row_no: number | null; column_key: string | null; issue_code: string; message: string }

export const importCommit: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId: string = ctx.tenantId;
  const importId = payload?.import_id;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof importId !== 'string' || !UUID.test(importId)) {
    ctx.log?.warn?.({ event: 'import_commit_skipped', reason: 'bad_payload' });
    return;
  }
  const replaceDraft = payload.replace_draft === true;       // exactly true; never taken from anything else in the payload
  const cfg = loadCatalogConfig(process.env);
  const q = (text: string, values: unknown[]) => ctx.tx.query(text, values) as Promise<{ rows: any[] }>;
  const nowIso: string = ctx.now();

  // Row lock first: a concurrent duplicate delivery waits here and then sees `committed`.
  const imp = (await q('SELECT * FROM catalog.imports WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, importId])).rows[0];
  if (!imp || imp.status !== 'committing' || !(imp.kind === 'price_list' || (KINDS as readonly string[]).includes(imp.kind))) return;

  const committer = imp.committed_by;
  const reason = typeof imp.commit_change_reason === 'string' ? imp.commit_change_reason.trim() : '';
  if (typeof committer !== 'string' || reason === '') throw Object.assign(new Error('import row has no commit parameters'), { code: 'common.internal' });
  const listId: string = imp.target_price_list_id;
  const actor = ctx.actor.id as string;

  const up = imp.upload_file_id
    ? (await q('SELECT content FROM catalog.files WHERE tenant_id = $1 AND id = $2', [tenantId, imp.upload_file_id])).rows[0] : undefined;
  if (!up) throw Object.assign(new Error('upload file not found'), { code: 'common.not_found' });

  // ---- re-validation of the stored sheet against the current catalog (errors only; warnings do not block a commit)
  const issues: Issue[] = [];
  const err = (code: string, sheet: string, row: number | null = null, col: string | null = null) => issues.push({ sheet, row_no: row, column_key: col, issue_code: code, message: MSG[code]! });

  /** commit_failed: nothing applied; the issues are appended after the validation ones. RESOLVES (the state must persist). */
  async function failCommit() {
    const last = (await q('SELECT seq FROM catalog.import_issues WHERE tenant_id = $1 AND import_id = $2 ORDER BY seq DESC LIMIT 1', [tenantId, importId])).rows[0];
    let seq = Number(last?.seq ?? 0);
    const expires = new Date(Date.parse(imp.expires_at ? new Date(imp.expires_at).toISOString() : nowIso) + cfg.fileRetentionDays * 86_400_000);
    const keep = issues.slice(0, cfg.importMaxIssues);
    for (let s = 0; s < keep.length; s += CHUNK) {
      const vals: unknown[] = [];
      const tuples = keep.slice(s, s + CHUNK).map((x) => {
        const b = vals.length;
        vals.push(tenantId, importId, ++seq, 'error', x.sheet, x.row_no, x.column_key, x.issue_code, x.message, nowIso, actor, expires);
        return `(${Array.from({ length: 12 }, (_, j) => `$${b + j + 1}`).join(', ')})`;
      });
      await q(`INSERT INTO catalog.import_issues (tenant_id, import_id, seq, severity, sheet, row_no, column_key, issue_code, message, created_at, created_by, expires_at) VALUES ${tuples.join(', ')}`, vals);
    }
    await q("UPDATE catalog.imports SET status = 'commit_failed', version = version + 1, updated_at = $3, updated_by = $4 WHERE tenant_id = $1 AND id = $2", [tenantId, importId, nowIso, actor]);
    ctx.metrics?.inc?.('lims_catalog_imports_total', { kind: imp.kind, outcome: 'commit_failed' });
    ctx.log?.warn?.({ event: 'import_commit_failed', import_id: importId, issues: issues.length });
  }

  if (imp.kind !== 'price_list') {
    let sheets: Awaited<ReturnType<typeof readXlsx>> | undefined;
    try { sheets = await readXlsx(up.content); } catch (e) { err(e instanceof XlsxReadError ? e.code : 'file.not_xlsx', FILE_SHEET); }
    const plan = sheets ? await planKind(imp.kind, sheets, q, tenantId, (code, sheet, row, col) => { if (sev(code) === 'error') err(code, sheet, row ?? null, col ?? null); }) : undefined;
    if (plan && !issues.length && !replaceDraft) for (const _ of plan.drafts) err('file.draft_exists', FILE_SHEET);   // one per target (§8.5)
    if (!plan || issues.length) { await failCommit(); return; }
    const now = new Date(nowIso);
    const w: Writer = { q, tenantId, actor: committer, now, effective: imp.commit_effective_from ? new Date(imp.commit_effective_from) : now, reason, importId, touched: new Set() };
    const upd = (t: string, id: string) => q(`UPDATE catalog.${t} SET status = 'discarded', version = version + 1, updated_at = $3, updated_by = $4 WHERE tenant_id = $1 AND id = $2`, [tenantId, id, now, committer]);
    for (const d of plan.drafts) await upd(d.table, d.id);                       // replace_draft === true here
    await plan.apply(w);
    const sctx = { ...ctx, actor: { ...ctx.actor, id: committer } };
    const { revision } = await createRevisionService({ events: { publish: (...a: unknown[]) => ctx.events.publish(...a) } } as never)
      .bumpRevision(sctx, { entityType: 'catalog_import', entityId: importId, changeKind: 'updated', effectiveFrom: nowIso });
    if (w.touched.size) await q('UPDATE catalog.orderables SET revision = $2 WHERE tenant_id = $1 AND id = ANY($3)', [tenantId, revision, [...w.touched]]);
    await q(
      "UPDATE catalog.imports SET status = 'committed', committed_at = $3, last_error_code = NULL, version = version + 1, updated_at = $3, updated_by = $4 WHERE tenant_id = $1 AND id = $2",
      [tenantId, importId, nowIso, committer]);
    ctx.metrics?.inc?.('lims_catalog_imports_total', { kind: imp.kind, outcome: 'committed' });
    return;
  }
  const wanted = new Map<string, number>();                 // orderable id -> paise
  let sheets: Awaited<ReturnType<typeof readXlsx>> | undefined;
  try { sheets = await readXlsx(up.content); } catch (e) { err(e instanceof XlsxReadError ? e.code : 'file.not_xlsx', FILE_SHEET); }
  const prices = sheets?.find((s) => s.name === 'Prices');
  if (sheets && !prices) err('file.sheet_missing', 'Prices');
  if (prices) {
    const col: Record<string, number> = {};
    (prices.rows[0] ?? []).forEach((h, i) => { const k = txt(h); if (KNOWN_COLS.includes(k)) col[k] ??= i; });
    if (col['orderable_code'] === undefined || col['unit_price_npr'] === undefined) err('file.header_mismatch', 'Prices', 1);
    else {
      const cat = new Map<string, { id: string; kind: string }>();
      for (const o of (await q('SELECT id, code, kind FROM catalog.orderables WHERE tenant_id = $1', [tenantId])).rows) cat.set(String(o.code).toUpperCase(), o);
      const seen = new Set<string>();
      prices.rows.slice(1).forEach((r, i) => {
        if (r.every(blank)) return;
        const rn = i + 2;                                      // worksheet row number, header = 1
        const cell = (k: string) => (col[k] === undefined ? null : r[col[k]!] ?? null);
        const code = txt(cell('orderable_code')).toUpperCase();
        let o: { id: string; kind: string } | undefined;
        if (code === '') err('row.required_missing', 'Prices', rn, 'orderable_code');
        else if (!CODE_RE.test(code)) err('row.code_invalid', 'Prices', rn, 'orderable_code');
        else if (seen.has(code)) err('row.duplicate_code', 'Prices', rn, 'orderable_code');
        else {
          seen.add(code);
          o = cat.get(code);
          if (!o) err('row.orderable_unknown', 'Prices', rn, 'orderable_code');
          else { const kd = txt(cell('orderable_kind')).toLowerCase(); if (kd !== '' && kd !== o.kind) err('row.kind_mismatch', 'Prices', rn, 'orderable_kind'); }
        }
        const pv = cell('unit_price_npr');
        let paise: number | undefined;
        if (blank(pv)) err('row.required_missing', 'Prices', rn, 'unit_price_npr');
        else { const p = parsePrice(pv); if ('code' in p) err(p.code, 'Prices', rn, 'unit_price_npr'); else paise = p.paise; }
        if (o && paise !== undefined) wanted.set(o.id, paise);
      });
    }
  }

  // ---- open drafts of the target (V1: one per list)
  const drafts = (await q("SELECT id, version FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2 AND status = 'draft'", [tenantId, listId])).rows;
  if (drafts.length > 0 && !replaceDraft) issues.push({ sheet: FILE_SHEET, row_no: null, column_key: null, issue_code: 'file.draft_exists', message: DRAFT_MSG });

  if (issues.length > 0) { await failCommit(); return; }

  // ---- apply: the normal pricing service, in this transaction, on behalf of the committing user
  const svc = createPricingService({ events: { publish: (...a: unknown[]) => ctx.events.publish(...a) }, identity: {} } as never) as any;
  const sctx = { ...ctx, actor: { ...ctx.actor, id: committer } };
  for (const d of drafts) await svc.discardPriceListVersionDraft(sctx, { versionId: d.id, expectedVersion: Number(d.version) });
  const draft = await svc.createPriceListVersionDraft(sctx, { id: listId, sourceImportId: importId });
  const versionId: string = draft.id;
  const entries = [...wanted];
  for (let s = 0; s < entries.length; s += BATCH) {
    const { results } = await svc.upsertPriceListItems(sctx, { versionId, body: { items: entries.slice(s, s + BATCH).map(([orderable_id, p]) => ({ orderable_id, unit_price: { amount_paisa: p, currency: 'NPR' } })) } });
    if (results.some((r: any) => r.outcome === 'error')) throw Object.assign(new Error('item apply failed'), { code: 'common.internal' });
  }
  const stale = (await q('SELECT orderable_id FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [tenantId, versionId])).rows
    .map((r) => r.orderable_id as string).filter((id) => !wanted.has(id));     // full replacement: the sheet is the whole truth
  for (let s = 0; s < stale.length; s += BATCH) await svc.removePriceListItems(sctx, { versionId, body: { ids: stale.slice(s, s + BATCH) } });
  if (imp.commit_publish !== false) {
    const ver = (await q('SELECT version FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2', [tenantId, versionId])).rows[0];
    await svc.publishPriceListVersion(sctx, {
      versionId, expectedVersion: Number(ver.version),
      body: { change_reason: reason, effective_from: imp.commit_effective_from ? new Date(imp.commit_effective_from).toISOString() : nowIso },
    });
  }
  await q(
    "UPDATE catalog.imports SET status = 'committed', result_price_list_version_id = $3, committed_at = $4, last_error_code = NULL, version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2",
    [tenantId, importId, versionId, nowIso, committer]);
  ctx.metrics?.inc?.('lims_catalog_imports_total', { kind: 'price_list', outcome: 'committed' });
};
