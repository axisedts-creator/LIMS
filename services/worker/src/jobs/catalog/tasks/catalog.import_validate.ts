// catalog.import_validate (02-TRD §8.3, §8.6, §10): scan -> ZIP inspect + parse (XlsxReader) -> row validation against the
// tenant catalog (dry run: only imports / files / import_issues are written) -> annotated report -> validated | invalid.
// Kind price_list is validated here; catalog_master / referrers / credit_parties by the planners in catalog.import_kinds.ts (T-25).
// No cell value is ever stored in an issue or logged (05-SCHEMA §9, 07 S-13).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadCatalogConfig } from '../../../../../api/src/modules/catalog/config.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { XlsxReadError, readXlsx, type Sheet } from '../xlsx/XlsxReader.js';
import { writeXlsx } from '../xlsx/XlsxWriter.js';
import { CODE_RE, KINDS, blank, planKind, txt } from './catalog.import_kinds.js';

export { CODE_RE, blank, txt };

export const IMPORT_VALIDATE = 'catalog.import_validate';

const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const WORKING = ['uploaded', 'scanning', 'validating'];
const MAX_PRICE = 9_999_999.99;
export const FILE_SHEET = '(file)';                       // [CONV] sheet label for file-level issues
const CHUNK = 400;                                   // issue rows per INSERT (12 binds each)
const KNOWN_COLS = ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr'];
const ALL_KINDS: readonly string[] = ['price_list', ...KINDS];
const rowKey = (sheet: string, row: number) => `${sheet}\u0000${row}`;

type Severity = 'error' | 'warning';
interface Issue { severity: Severity; sheet: string; row_no: number | null; column_key: string | null; issue_code: string; message: string }

// Template text only: never a cell value.
export const MSG: Record<string, string> = {
  'file.not_xlsx': 'The file is not a valid .xlsx workbook.',
  'file.zip_unsafe': 'The file structure was rejected as unsafe.',
  'file.macro_present': 'The workbook contains macros, which are not allowed.',
  'file.external_links': 'The workbook contains external links, which are not allowed.',
  'file.parse_timeout': 'The workbook took too long to read.',
  'file.too_many_rows': 'A sheet has more than 20,000 rows.',
  'file.sheet_missing': 'A required sheet is missing.',
  'file.header_mismatch': 'A required column is missing from the header row.',
  'file.unknown_column': 'Unknown column ignored.',
  'file.meta_missing': 'A required _meta entry is missing.',
  'file.meta_mismatch': 'The _meta sheet is for a different template kind or price list.',
  'file.stale_base': 'The price list was published after this file was exported; the comparison uses the latest published version.',
  'file.too_many_issues': 'Too many issues; only the first ones are listed. All rows were still counted.',
  'row.required_missing': 'A required cell is empty.',
  'row.code_invalid': 'The orderable code has an invalid format.',
  'row.duplicate_code': 'The orderable code appears more than once.',
  'row.orderable_unknown': 'The orderable code is not in the catalog.',
  'row.orderable_inactive': 'The orderable is inactive.',
  'row.kind_mismatch': 'The orderable kind does not match the catalog.',
  'row.price_invalid': 'The price must be a number from 0 to 9,999,999.99.',
  'row.price_decimals': 'The price has more than 2 decimals.',
  'row.price_change_large': 'The price changes by more than the warning threshold.',
  'row.reference_unknown': 'The referenced code is not in the workbook or the catalog.',
  'row.value_invalid': 'The value is not allowed for this column.',
  'row.formula_invalid': 'The formula is invalid (syntax, unknown or non-numeric input, or a cycle).',
  'row.range_overlap': 'The range overlaps another range of the same analyte.',
  'row.panel_cycle': 'The panel would contain itself.',
  'row.phone_invalid': 'The phone number is not in international format.',
  'row.email_invalid': 'The email address is invalid.',
  'file.draft_exists': 'A target already has an open draft version; discard it or commit with replace_draft.',
};

const WARNINGS = ['file.unknown_column', 'file.stale_base', 'file.too_many_issues', 'row.orderable_inactive', 'row.price_change_large'];
export const sev = (code: string): 'error' | 'warning' => (WARNINGS.includes(code) ? 'warning' : 'error');

/** Number or numeric text, 0..MAX, <= 2 decimals. Anything else (commas, symbols, sign, bool, date) is price_invalid. */
export function parsePrice(v: unknown): { paise: number } | { code: 'row.price_invalid' | 'row.price_decimals' } {
  const invalid = { code: 'row.price_invalid' as const };
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0 || v > MAX_PRICE) return invalid;
    s = String(v);
  } else if (typeof v === 'string') {
    s = v.trim();
    if (!/^\d+(\.\d+)?$/.test(s) || Number(s) > MAX_PRICE) return invalid;
  } else return invalid;
  if (/e/i.test(s) || (s.split('.')[1] ?? '').replace(/0+$/, '').length > 2) return { code: 'row.price_decimals' };
  return { paise: Math.round(Number(s) * 100) };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const importValidate: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId: string = ctx.tenantId;
  const importId = payload?.import_id;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof importId !== 'string') {
    ctx.log?.warn?.({ event: 'import_validate_skipped', reason: 'bad_payload' });
    return;
  }
  const cfg = loadCatalogConfig(process.env);
  const q = (text: string, values: unknown[]) => ctx.tx.query(text, values) as Promise<{ rows: any[]; rowCount: number }>;
  const nowIso: string = ctx.now();
  const actor: string = ctx.actor.id;

  // Idempotency: re-read; anything but uploaded/scanning/validating is a duplicate delivery. Plain read (no lock) so the
  // independent scan_unavailable write below cannot block on this transaction.
  const imp = (await q(
    'SELECT id, kind, status, target_price_list_id, upload_file_id, file_name FROM catalog.imports WHERE tenant_id = $1 AND id = $2', [tenantId, importId])).rows[0];
  if (!imp || !WORKING.includes(imp.status) || !ALL_KINDS.includes(imp.kind)) return;
  const kind: string = imp.kind;

  const up = imp.upload_file_id
    ? (await q('SELECT content FROM catalog.files WHERE tenant_id = $1 AND id = $2', [tenantId, imp.upload_file_id])).rows[0] : undefined;
  if (!up) throw Object.assign(new Error('upload file not found'), { code: 'common.not_found' });
  const bytes: Uint8Array = up.content;

  // Row lock + re-check right before any write (a concurrent duplicate may have finished while we scanned/parsed).
  const lock = async () => WORKING.includes((await q(
    'SELECT status FROM catalog.imports WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, importId])).rows[0]?.status);
  const setState = (c: any, status: string, code: string) => c.tx.query(
    'UPDATE catalog.imports SET status = $3, last_error_code = $4, version = version + 1, updated_at = $5, updated_by = $6 WHERE tenant_id = $1 AND id = $2',
    [tenantId, importId, status, code, nowIso, actor]);
  const quarantine = async () => {
    if (!(await lock())) return;
    await setState(ctx, 'quarantined', 'common.upload_quarantined');
    ctx.metrics?.inc?.('lims_catalog_imports_total', { kind, outcome: 'quarantined' });   // 02-TRD §12
    ctx.log?.error?.({ event: 'import_quarantined', import_id: importId });
  };

  // ---- 1. malware scan: mandatory unless LIMS_CORE_ENV=dev (unset = strict, fail closed)
  let verdict: string;
  try { verdict = await ctx.files.scan(bytes); } catch { verdict = 'unavailable'; }
  if (verdict !== 'clean' && verdict !== 'infected') {
    if (process.env.LIMS_CORE_ENV === 'dev') {
      ctx.log?.warn?.({ event: 'scan_unavailable', import_id: importId });
    } else if (ctx.attempt >= ctx.maxAttempts) {
      await quarantine();
      return;
    } else {
      await ctx.db.tx((c: any) => setState(c, 'scanning', 'scan_unavailable'));   // survives the failed attempt
      throw Object.assign(new Error('scan unavailable'), { code: 'scan_unavailable' });
    }
  }
  if (verdict === 'infected') { await quarantine(); return; }

  // ---- 2-3. ZIP inspection + parse (XlsxReader inspects first and restores neutralised text)
  const issues: Issue[] = [];
  const rowCodes = new Map<string, string[]>();
  let errors = 0, warnings = 0, truncated = false;
  const add = (severity: Severity, code: string, sheet: string, row: number | null = null, col: string | null = null) => {
    if (severity === 'error') errors++; else warnings++;
    if (row !== null) { const k = rowKey(sheet, row), l = rowCodes.get(k); if (l) l.push(code); else rowCodes.set(k, [code]); }
    if (issues.length < cfg.importMaxIssues) issues.push({ severity, sheet, row_no: row, column_key: col && col.slice(0, 40), issue_code: code, message: MSG[code]! });
    else truncated = true;
  };
  const flag = (code: string, sheet: string, row?: number | null, col?: string | null) => add(sev(code), code, sheet, row ?? null, col ?? null);

  let sheets: Sheet[] | undefined;
  try {
    sheets = await readXlsx(bytes);
  } catch (e) {
    flag(e instanceof XlsxReadError ? e.code : 'file.not_xlsx', FILE_SHEET);   // a library failure on a crafted file is bad input, not an outage
  }

  let rows = 0, added = 0, changed = 0, unchanged = 0, removed = 0;
  let baseNo: number | null = null;
  let extra: Record<string, number> = {};
  if (sheets && kind !== 'price_list') {
    const plan = await planKind(kind, sheets, q, tenantId, flag);
    ({ rows, added, changed, unchanged, extra } = plan);
  } else if (sheets) {
    const prices = sheets.find((s) => s.name === 'Prices');
    const meta = sheets.find((s) => s.name === '_meta');
    // _meta: only template_kind / template_version / price_list_id / base_version_no are read (§8.2)
    const m = new Map<string, unknown>();
    for (const r of meta?.rows ?? []) if (typeof r[0] === 'string') m.set(r[0].trim(), r[1]);
    let metaOk = true;
    const need = (k: string) => { if (blank(m.get(k))) { flag('file.meta_missing', '_meta'); metaOk = false; return false; } return true; };
    if (!meta) { flag('file.meta_missing', '_meta'); metaOk = false; } else {
      if (need('template_kind') && txt(m.get('template_kind')) !== 'price_list') { flag('file.meta_mismatch', '_meta'); metaOk = false; }
      if (need('template_version') && Number(m.get('template_version')) !== 1) { flag('file.meta_mismatch', '_meta'); metaOk = false; }
      if (need('price_list_id') && txt(m.get('price_list_id')) !== imp.target_price_list_id) { flag('file.meta_mismatch', '_meta'); metaOk = false; }
      if (need('base_version_no')) {
        const b = m.get('base_version_no');
        const n = typeof b === 'number' ? b : /^\d+$/.test(txt(b)) ? Number(txt(b)) : NaN;
        if (Number.isInteger(n) && n >= 0) baseNo = n; else { flag('file.meta_mismatch', '_meta'); metaOk = false; }
      }
    }

    let col: Record<string, number> = {};
    let headerOk = false;
    if (!prices) flag('file.sheet_missing', 'Prices');
    else {
      (prices.rows[0] ?? []).forEach((h, i) => {
        const k = txt(h);
        if (k === '') return;
        if (KNOWN_COLS.includes(k)) col[k] ??= i; else flag('file.unknown_column', 'Prices', 1, k);
      });
      headerOk = col.orderable_code !== undefined && col.unit_price_npr !== undefined;
      if (!headerOk) flag('file.header_mismatch', 'Prices', 1);
    }

    // ---- 4. row validation against the current catalog (tenant-bound reads)
    const data = prices ? prices.rows.slice(1) : [];
    if (prices && headerOk) {
      const cat = new Map<string, { id: string; kind: string; is_active: boolean }>();
      for (const o of (await q('SELECT id, code, kind, is_active FROM catalog.orderables WHERE tenant_id = $1', [tenantId])).rows) cat.set(String(o.code).toUpperCase(), o);
      const latest = (await q(
        `SELECT id, version_no FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2 AND status IN ('published', 'superseded') ORDER BY version_no DESC LIMIT 1`,
        [tenantId, imp.target_price_list_id])).rows[0];
      const base = new Map<string, number>();
      if (latest) for (const it of (await q('SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [tenantId, latest.id])).rows)
        base.set(it.orderable_id, Number(it.unit_price_paisa));          // bigint arrives as string
      if (metaOk && baseNo !== (latest?.version_no ?? 0)) flag('file.stale_base', '_meta');

      const seen = new Set<string>(), present = new Set<string>();
      data.forEach((r, i) => {
        if (r.every(blank)) return;
        rows++;
        const rn = i + 2;                                                  // worksheet row number, header = 1
        const cell = (k: string) => (col[k] === undefined ? null : r[col[k]!] ?? null);
        const raw = txt(cell('orderable_code')).toUpperCase();
        let o: { id: string; kind: string; is_active: boolean } | undefined;
        let dup = false, codeOk = false;
        if (raw === '') flag('row.required_missing', 'Prices', rn, 'orderable_code');
        else if (!CODE_RE.test(raw)) flag('row.code_invalid', 'Prices', rn, 'orderable_code');
        else {
          codeOk = true;
          if (seen.has(raw)) { dup = true; flag('row.duplicate_code', 'Prices', rn, 'orderable_code'); }
          seen.add(raw);
          o = cat.get(raw);
          if (!o) flag('row.orderable_unknown', 'Prices', rn, 'orderable_code');
          else {
            present.add(o.id);
            if (!o.is_active) flag('row.orderable_inactive', 'Prices', rn, 'orderable_code');
            const kd = txt(cell('orderable_kind')).toLowerCase();
            if (kd !== '' && kd !== o.kind) flag('row.kind_mismatch', 'Prices', rn, 'orderable_kind');
          }
        }
        let paise: number | undefined;
        const pv = cell('unit_price_npr');
        if (blank(pv)) flag('row.required_missing', 'Prices', rn, 'unit_price_npr');
        else {
          const p = parsePrice(pv);
          if ('code' in p) flag(p.code, 'Prices', rn, 'unit_price_npr'); else paise = p.paise;
        }
        if (!codeOk || dup || !o || paise === undefined) return;
        const old = base.get(o.id);
        if (old === undefined) added++;
        else if (old === paise) unchanged++;
        else {
          changed++;
          if (old > 0 && Math.abs(paise - old) / old * 100 > cfg.priceChangeWarnPct) flag('row.price_change_large', 'Prices', rn, 'unit_price_npr');
        }
      });
      removed = [...base.keys()].filter((id) => !present.has(id)).length;
    } else if (prices) rows = data.filter((r) => !r.every(blank)).length;
  }
  if (truncated) { warnings++; issues.push({ severity: 'warning', sheet: FILE_SHEET, row_no: null, column_key: null, issue_code: 'file.too_many_issues', message: MSG['file.too_many_issues']! }); }

  // ---- 5. annotated report (original rows + `issues` column + `Issues` sheet; the writer neutralises every text cell)
  const status = errors === 0 ? 'validated' : 'invalid';
  const summary = { rows, added, changed, removed, unchanged, errors, warnings, ...extra };
  const reportSheets: Array<{ name: string; rows: unknown[][] }> = [];
  // price_list: the Prices sheet; other kinds: every sheet but _meta (the report never carries _meta)
  for (const s of sheets?.filter((x) => (kind === 'price_list' ? x.name === 'Prices' : x.name !== '_meta' && x.name !== 'Issues')) ?? []) {
    const width = s.rows.reduce((w, r) => Math.max(w, r.length), 0);
    reportSheets.push({ name: s.name, rows: s.rows.map((r, i) => [
      ...Array.from({ length: width }, (_, j) => r[j] ?? null),
      i === 0 ? 'issues' : (rowCodes.get(rowKey(s.name, i + 1))?.join('; ') ?? null)]) });
  }
  reportSheets.push({ name: 'Issues', rows: [   // always: AC-16.10 also covers file-level rejections
    ['seq', 'severity', 'sheet', 'row_no', 'column_key', 'issue_code', 'message'],
    ...issues.map((x, i) => [i + 1, x.severity, x.sheet, x.row_no, x.column_key, x.issue_code, x.message])] });
  const report = await writeXlsx(reportSheets);

  // ---- 6. persist in one transaction
  if (!(await lock())) return;
  const impExp = new Date(Date.parse(nowIso) + cfg.importTtlHours * 3_600_000);
  const fileExp = new Date(impExp.getTime() + cfg.fileRetentionDays * 86_400_000);
  const reportId = uuidv7();
  const stem = String(imp.file_name).replace(/\.xlsx$/i, '').slice(0, 180) || 'import';
  await q(
    'INSERT INTO catalog.files (id, tenant_id, purpose, file_name, content_type, byte_size, sha256, content, expires_at, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [reportId, tenantId, 'import_report', `${stem}-report.xlsx`, XLSX_CT, report.length, sha256(report), Buffer.from(report), fileExp, nowIso, actor]);
  for (let s = 0; s < issues.length; s += CHUNK) {
    const part = issues.slice(s, s + CHUNK), vals: unknown[] = [];
    const tuples = part.map((x, i) => {
      const b = vals.length;
      vals.push(tenantId, importId, s + i + 1, x.severity, x.sheet, x.row_no, x.column_key, x.issue_code, x.message, nowIso, actor, fileExp);
      return `(${Array.from({ length: 12 }, (_, j) => `$${b + j + 1}`).join(', ')})`;
    });
    await q(`INSERT INTO catalog.import_issues (tenant_id, import_id, seq, severity, sheet, row_no, column_key, issue_code, message, created_at, created_by, expires_at) VALUES ${tuples.join(', ')}`, vals);
  }
  await q('UPDATE catalog.files SET expires_at = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, imp.upload_file_id, fileExp]);
  await q(
    'UPDATE catalog.imports SET status = $3, summary = $4::jsonb, error_count = $5, warning_count = $6, base_version_no = $7, report_file_id = $8, validated_at = $9, expires_at = $10, last_error_code = NULL, version = version + 1, updated_at = $9, updated_by = $11 WHERE tenant_id = $1 AND id = $2',
    [tenantId, importId, status, JSON.stringify(summary), errors, warnings, baseNo, reportId, nowIso, impExp, actor]);
  ctx.metrics?.inc?.('lims_catalog_imports_total', { kind, outcome: status });
};
