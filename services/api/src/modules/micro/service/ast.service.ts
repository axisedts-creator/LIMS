// M11 assignAstPanel, M12 recordAstResults, M29 listAstPanels, M30 createAstPanel, M31 versionAstPanel, M32 deactivateAstPanel
// (02-TRD §4.2 panel precedence, §4.3 raw value, §4.4 interpretation, §5, §12, §13; PRD AC-06.1–06.6, AC-06.3a, AC-16.1; 07-SECURITY S-01, S-03, S-05, S-09, S-23, T-A3, T-A4, T-E1).
// M11 / M12: the isolate is read FIRST (RLS + tenant; absent = 404, same as another tenant's), THEN IdentityPort.assertRole(micro.culture.work, isolate.centre_id) (02-CV §10.1),
// THEN culture row FOR UPDATE, isolate row FOR UPDATE (same lock order as M4 / M7–M10). M29–M32 ask their permission in the handler (no object, no centre).
// AC-16.1: nothing here accepts, writes or names `report_visibility`; rows this module creates take the database default ('shown'), updated rows keep the stored value.
// Error bodies are fixed text: no submitted value (raw_value included) is echoed or logged (REQ-SEC-024, T-D1).
// [CONV] M12 per-entry outcomes: HTTP 200, results[i] in request order; an entry that writes does so inside its own SAVEPOINT (a failed statement aborts a PostgreSQL transaction otherwise, 25P02).
// [CONV] M12 reads are batched (antibiotics, the isolate's AST rows, the panel's antibiotics, the interpretation catalog: one statement each) — the SELECT count does not grow with the entries (TRD §10).
// [CONV] M12 `accept_suggestion` / `breakpoint_band_id` (TRD §4.5) belong to T-13: until it lands an entry that sets either is a per-entry common.validation_failed (never silently dropped).
//   `qualifier_code` is validated and ignored (it only keys breakpoint rows); `standard` / `standard_version` without a `category_code` are ignored (stored only with a category).
// [CONV] panel membership of an M12 entry: the isolate already has the (antibiotic, method) row -> update; else the antibiotic is in the isolate's panel -> insert (off_panel false, panel order);
//   else add_to_isolate -> insert off_panel true; else micro.antibiotic_not_in_panel.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertCultureChildEditable, type CultureStatus } from '../domain/culture.state.js';
import { validateInterpretation, type InterpretationCatalog } from '../domain/interpretation.js';
import { assertAstPanelAssignable, type IsolateStatus } from '../domain/isolate.state.js';
import { parseAstValue, type AstMethod } from '../domain/ast-value.js';
import { selectAstPanel } from '../domain/selection.js';
import * as dto from '../mappers/culture.dto.js';
import { panelDto } from '../mappers/ast.mappers.js';
import * as repo from '../repository/ast.repo.js';
import * as sets from '../repository/codedsets.repo.js';
import * as cultureRepo from '../repository/cultures.repo.js';
import * as isolateRepo from '../repository/isolates.repo.js';
import { answer } from './isolate.service.js';
import { bad, code, conflict, guarded, isObj, needVersion, nowOf, str, strictKeys, uuid, WORK, type WriteCtx } from './culture.service.js';

type Obj = Record<string, any>;
type Out = { body: Obj; version?: number; status?: number };

const METHODS: readonly string[] = ['mic', 'zone_diameter', 'other'];
const STANDARDS: readonly string[] = ['CLSI', 'EUCAST', 'ECOFF'];
const CATEGORY = /^[A-Za-z^]{1,8}$/;
const pgCode = (e: unknown): string | undefined => { const x = e as { code?: unknown } | null; return typeof x?.code === 'string' ? x.code : undefined; };
const method = (v: unknown, p: string): string => (typeof v === 'string' && METHODS.includes(v) ? v : bad(p));
const bool = (v: unknown, p: string): boolean => (typeof v === 'boolean' ? v : bad(p));

function scope(c: WriteCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  return { tx: c.tx, tenantId: c.tenantId, userId: c.actor.id };
}

/** Isolate first (404), then the permission with its centre; the culture and the isolate are locked afterwards by `lockEditable`. */
async function loadIsolate(c: WriteCtx, params: unknown): Promise<{ tx: any; tenantId: string; userId: string; read: Obj }> {
  const { tx, tenantId, userId } = scope(c);
  const id = uuid(isObj(params) ? params['isolate_id'] : undefined, '/isolate_id').toLowerCase();
  const read = await isolateRepo.getIsolate(tx, { tenantId, id });   // unlocked: the culture is locked first (T-09 review #1)
  if (!read) throw new LimsError('common.not_found');
  const identity = c.ports?.IdentityPort;
  if (!identity) throw new LimsError('auth.forbidden');   // fail closed
  await identity.assertRole(c, { permission: WORK, centreId: read['centre_id'] });
  return { tx, tenantId, userId, read };
}

/** culture FOR UPDATE, then isolate FOR UPDATE; the culture decides first (final -> report_final_locked, cancelled -> culture_invalid_transition). */
async function lockEditable(tx: any, tenantId: string, read: Obj): Promise<{ culture: Obj; isolate: Obj }> {
  const culture = await cultureRepo.lockCulture(tx, { tenantId, id: read['culture_id'] });
  if (!culture) throw new LimsError('common.not_found');
  const isolate = await isolateRepo.getIsolateForUpdate(tx, { tenantId, id: read['id'] });
  if (!isolate) throw new LimsError('common.not_found');
  assertCultureChildEditable(culture['status'] as CultureStatus);
  return { culture, isolate };
}

// ---------------------------------------------------------------- M11
export async function assignAstPanel(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, read } = await loadIsolate(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['ast_panel_id', 'method']);   // S-05: nothing else (report_visibility, status, version ...)
  const panelId = b['ast_panel_id'] === undefined ? undefined : uuid(b['ast_panel_id'], '/ast_panel_id').toLowerCase();
  const bodyMethod = b['method'] === undefined ? undefined : method(b['method'], '/method');
  const expected = needVersion(input.ifMatch);

  const { culture, isolate } = await lockEditable(tx, tenantId, read);
  if (Number(isolate['version']) !== expected) conflict();
  assertAstPanelAssignable(isolate['status'] as IsolateStatus);   // pending_id / withdrawn -> micro.isolate_invalid_transition

  let panel: Obj;
  if (panelId !== undefined) {
    const given = await repo.getPanel(tx, { tenantId, id: panelId });   // another tenant's panel is simply absent: 404 (S-01)
    if (!given) throw new LimsError('common.not_found');
    if ((given['superseded_at'] != null || given['is_active'] !== true) && given['id'] !== isolate['ast_panel_id']) throw new LimsError('common.id_mismatch');   // S-03 / TRD §13
    panel = given;
  } else {
    const organism = String(isolate['organism_code']);
    const group = (await sets.codeRows(tx, { view: 'organisms', tenantId, codes: [organism] })).get(organism)?.['organism_group_code'] ?? null;
    const candidates = (await repo.currentPanels(tx, { tenantId })).map((p) => ({ ...p, superseded_at: p['superseded_at'] == null ? null : new Date(p['superseded_at']) })) as unknown as Parameters<typeof selectAstPanel>[0];
    const chosen = selectAstPanel(candidates, { organism_code: organism, organism_group_code: group, specimen_site_code: culture['specimen_site_code'] ?? null });
    if (chosen === null) bad('/ast_panel_id');   // 08 A13 P-1: no matching panel
    panel = (await repo.getPanel(tx, { tenantId, id: chosen!.id }))!;
  }

  const defaultMethod = bodyMethod ?? String(panel['default_method']);
  const abx = await repo.panelAntibiotics(tx, { tenantId, panelIds: [panel['id']] });
  const done = await guarded(async () => {
    const updated = await repo.setIsolatePanel(tx, { tenantId, id: isolate['id'], expectedVersion: expected, panelId: panel['id'], method: defaultMethod, userId });
    if (!updated) return conflict();
    await repo.insertPendingRows(tx, { tenantId, userId, centreId: isolate['centre_id'], cultureId: isolate['culture_id'], isolateId: isolate['id'],
      rows: abx.map((a) => ({ id: uuidv7(), antibioticCode: a['antibiotic_code'], method: a['method'] ?? defaultMethod, isReportable: a['is_reported_default'] === true, sortOrder: Number(a['sort_order']) })) });
    return updated;
  });
  return answer(c, tx, tenantId, done, undefined, true);
}

// ---------------------------------------------------------------- M12
interface Entry { antibiotic_code: string; method: string; raw_value?: string; category_code?: string; standard?: string; standard_version?: string; accept_suggestion?: boolean;
  breakpoint_band_id?: string; is_reportable?: boolean; add_to_isolate?: boolean; version?: number }
const ENTRY_KEYS = ['antibiotic_code', 'method', 'raw_value', 'category_code', 'standard', 'standard_version', 'accept_suggestion', 'breakpoint_band_id', 'qualifier_code', 'is_reportable', 'add_to_isolate', 'version'];

function parseEntries(body: unknown): Entry[] {
  const b = isObj(body) ? body : bad('/');
  strictKeys(b, ['entries']);
  const list = b['entries'];
  if (!Array.isArray(list) || list.length < 1 || list.length > 60) bad('/entries');
  return (list as unknown[]).map((raw, i): Entry => {
    const p = (f: string) => `/entries/${i}/${f}`;
    const o = isObj(raw) ? raw : bad(`/entries/${i}`);
    for (const k of Object.keys(o)) if (!ENTRY_KEYS.includes(k)) bad(`/entries/${i}/${k.slice(0, 64)}`);   // S-05 / T-A4 / AC-16.1: no provenance, visibility or id field
    const e: Entry = { antibiotic_code: code(o['antibiotic_code'], p('antibiotic_code')), method: method(o['method'], p('method')) };
    if (o['raw_value'] !== undefined) e.raw_value = str(o['raw_value'], p('raw_value'), 32);
    if (o['category_code'] !== undefined) e.category_code = typeof o['category_code'] === 'string' && CATEGORY.test(o['category_code']) ? o['category_code'] : bad(p('category_code'));
    if (o['standard'] !== undefined) e.standard = typeof o['standard'] === 'string' && STANDARDS.includes(o['standard']) ? o['standard'] : bad(p('standard'));
    if (o['standard_version'] !== undefined) e.standard_version = str(o['standard_version'], p('standard_version'), 32);
    if (o['accept_suggestion'] !== undefined) e.accept_suggestion = bool(o['accept_suggestion'], p('accept_suggestion'));
    if (o['breakpoint_band_id'] !== undefined) e.breakpoint_band_id = uuid(o['breakpoint_band_id'], p('breakpoint_band_id'));
    if (o['qualifier_code'] !== undefined) code(o['qualifier_code'], p('qualifier_code'));
    if (o['is_reportable'] !== undefined) e.is_reportable = bool(o['is_reportable'], p('is_reportable'));
    if (o['add_to_isolate'] !== undefined) e.add_to_isolate = bool(o['add_to_isolate'], p('add_to_isolate'));
    if (o['version'] !== undefined) e.version = Number.isSafeInteger(o['version']) && (o['version'] as number) >= 1 && (o['version'] as number) <= 2147483647 ? (o['version'] as number) : bad(p('version'));
    return e;
  });
}

const failed = (e: Entry, i: number, errCode: string, field: string): Obj => ({ antibiotic_code: e.antibiotic_code, method: e.method, outcome: 'error', code: errCode, path: field === '' ? `/entries/${i}` : `/entries/${i}/${field}` });

export async function recordAstResults(c: WriteCtx, input: { params: unknown; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, read } = await loadIsolate(c, input.params);
  const entries = parseEntries(input.body);   // whole-request 400 before anything is locked or written
  const { culture, isolate } = await lockEditable(tx, tenantId, read);
  if (isolate['status'] === 'withdrawn') throw new LimsError('micro.isolate_invalid_transition');   // AST rows of a withdrawn isolate are not edited

  // ---- batched reads
  const abxRows = await sets.codeRows(tx, { view: 'antibiotics', tenantId, codes: [...new Set(entries.map((e) => e.antibiotic_code))] });
  const rows = new Map<string, Obj>();
  for (const r of await repo.isolateResults(tx, { tenantId, isolateId: isolate['id'] })) rows.set(`${r['antibiotic_code']}|${r['method']}`, r);
  const panelAbx = new Map<string, Obj>();
  if (isolate['ast_panel_id']) for (const a of await repo.panelAntibiotics(tx, { tenantId, panelIds: [isolate['ast_panel_id']] })) if (!panelAbx.has(a['antibiotic_code'])) panelAbx.set(a['antibiotic_code'], a);
  const catalog: InterpretationCatalog = entries.some((e) => e.category_code !== undefined)
    ? { interpretations: (await repo.catalogInterpretations(tx)) as any, restrictions: (await repo.catalogRestrictions(tx)) as any } : { interpretations: [], restrictions: [] };

  const now = nowOf(c);
  const membershipId = c.actor.membershipId ?? null;
  const results: Obj[] = [];
  for (const [i, e] of entries.entries()) {
    const key = `${e.antibiotic_code}|${e.method}`;
    const existing = rows.get(key);
    const abx = abxRows.get(e.antibiotic_code);
    if (e.accept_suggestion === true || e.breakpoint_band_id !== undefined) { results.push(failed(e, i, 'common.validation_failed', e.accept_suggestion === true ? 'accept_suggestion' : 'breakpoint_band_id')); continue; }
    if (abx?.['is_active'] !== true) { results.push(failed(e, i, 'common.validation_failed', 'antibiotic_code')); continue; }
    if (e.version !== undefined && (!existing || Number(existing['version']) !== e.version)) { results.push(failed(e, i, 'common.version_conflict', 'version')); continue; }
    const member = panelAbx.get(e.antibiotic_code);
    if (!existing && !member && e.add_to_isolate !== true) { results.push(failed(e, i, 'micro.antibiotic_not_in_panel', 'antibiotic_code')); continue; }

    const parsed = e.raw_value === undefined ? undefined : parseAstValue(e.raw_value, e.method as AstMethod);
    if (parsed && !parsed.ok) { results.push(failed(e, i, parsed.code, 'raw_value')); continue; }
    const value = parsed?.ok ? parsed.value : undefined;
    if (e.category_code !== undefined) {
      const verdict = validateInterpretation({ category_code: e.category_code, standard: e.standard ?? null, standard_version: e.standard_version ?? null, antibiotic_code: e.antibiotic_code,
        raw_value: e.raw_value ?? existing?.['raw_value'] ?? null }, catalog);
      if (!verdict.ok) {
        const field = verdict.code === 'micro.ast_value_invalid' ? 'raw_value' : verdict.code === 'micro.ast_category_not_allowed' ? 'category_code' : e.standard === undefined ? 'standard' : 'standard_version';
        results.push(failed(e, i, verdict.code, field)); continue;
      }
    }
    const v: repo.ResultValues = {
      rawValue: value ? value.raw_value : existing?.['raw_value'] ?? null, rawQualifier: value ? value.raw_qualifier ?? null : existing?.['raw_qualifier'] ?? null,
      rawNumeric: value ? value.raw_numeric ?? null : existing?.['raw_numeric'] ?? null, unitCode: value ? value.unit_code ?? null : existing?.['unit_code'] ?? null,
      ...(e.category_code !== undefined
        ? { categoryCode: e.category_code, standard: e.standard!, standardVersion: e.standard_version!, standardSource: 'manual', interpretationSource: 'manual' }
        : { categoryCode: existing?.['category_code'] ?? null, standard: existing?.['standard'] ?? null, standardVersion: existing?.['standard_version'] ?? null,
          standardSource: existing?.['standard_source'] ?? null, interpretationSource: existing?.['interpretation_source'] ?? null }),
      isReportable: e.is_reportable ?? (existing ? existing['is_reportable'] === true : member ? member['is_reported_default'] === true : true),
    };

    const savepoint = `ast_entry_${i}`;
    await tx.query(`SAVEPOINT ${savepoint}`);
    try {
      const row = existing
        ? await repo.updateResult(tx, { tenantId, id: existing['id'], expectedVersion: Number(existing['version']), v, membershipId, at: now, userId })
        : await repo.insertResult(tx, { tenantId, id: uuidv7(), centreId: isolate['centre_id'], cultureId: culture['id'], isolateId: isolate['id'], antibioticCode: e.antibiotic_code, method: e.method, v,
          offPanel: !member, sortOrder: member ? Number(member['sort_order']) : null, membershipId, at: now, userId });
      if (!row) { await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await tx.query(`RELEASE SAVEPOINT ${savepoint}`); results.push(failed(e, i, 'common.version_conflict', 'version')); continue; }   // the row moved under us
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      const stored = { ...row, report_visibility: existing?.['report_visibility'] ?? 'shown' };   // AC-16.1: never written here; carried from the read (or the database default)
      rows.set(key, stored);
      results.push({ antibiotic_code: e.antibiotic_code, method: e.method, outcome: 'ok', ast_result: dto.astDto(stored, abx['display'] ?? e.antibiotic_code) });
    } catch (err) {
      if (pgCode(err) === 'P0001' && (err as { message?: unknown }).message === 'immutable_row') throw new LimsError('micro.report_final_locked');   // submitted meanwhile: the whole request
      if (pgCode(err) !== '23505') throw err;                                                                                                      // unexpected: the request transaction rolls back
      await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);                                                                                         // a concurrent writer won the (isolate, antibiotic, method) row
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      results.push(failed(e, i, 'common.version_conflict', ''));
    }
  }
  return { body: { results } };
}

// ---------------------------------------------------------------- M29–M32: panel configuration
interface PanelInput {
  code?: string; display: string; defaultMethod: string; organismCode: string | null; organismGroupCode: string | null; specimenSiteCode: string | null;
  antibiotics: { antibiotic_code: string; method: string | null; is_reported_default: boolean }[];
}
const PANEL_KEYS = ['display', 'default_method', 'organism_code', 'organism_group_code', 'specimen_site_code', 'antibiotics'];

function parsePanel(body: unknown, withCode: boolean): PanelInput {
  const b = isObj(body) ? body : bad('/');
  strictKeys(b, withCode ? ['code', ...PANEL_KEYS] : PANEL_KEYS);   // S-05: no version_no / superseded_at / is_active / tenant_id from the client
  const need = (k: string): unknown => (b[k] === undefined ? bad(`/${k}`) : b[k]);
  const opt = (k: string): string | null => (b[k] === undefined ? null : code(b[k], `/${k}`));
  const out: PanelInput = { display: str(need('display'), '/display', 120), defaultMethod: method(need('default_method'), '/default_method'),
    organismCode: opt('organism_code'), organismGroupCode: opt('organism_group_code'), specimenSiteCode: opt('specimen_site_code'), antibiotics: [] };
  if (withCode) out.code = code(need('code'), '/code');
  if (out.organismCode !== null && out.organismGroupCode !== null) bad('/organism_group_code');   // ast_panels__scope__ck
  const list = need('antibiotics');
  if (!Array.isArray(list) || list.length < 1 || list.length > 60) bad('/antibiotics');
  const seen = new Set<string>();
  out.antibiotics = (list as unknown[]).map((raw, i) => {
    const o = isObj(raw) ? raw : bad(`/antibiotics/${i}`);
    strictKeys(o, ['antibiotic_code', 'method', 'is_reported_default']);   // strictKeys paths are /<key>; the field set is closed either way
    const antibioticCode = code(o['antibiotic_code'], `/antibiotics/${i}/antibiotic_code`);
    const m = o['method'] === undefined ? null : method(o['method'], `/antibiotics/${i}/method`);
    const k = `${antibioticCode}|${m ?? out.defaultMethod}`;   // ast_panel_antibiotics unique key treats NULL methods as distinct: the service refuses the duplicate itself
    if (seen.has(k)) bad(`/antibiotics/${i}/antibiotic_code`);
    seen.add(k);
    return { antibiotic_code: antibioticCode, method: m, is_reported_default: bool(o['is_reported_default'], `/antibiotics/${i}/is_reported_default`) };
  });
  return out;
}

/** Coded references the database cannot FK across the global / tenant union (05-SCHEMA §8). */
async function checkRefs(tx: any, tenantId: string, p: PanelInput): Promise<void> {
  const active = async (view: 'organisms' | 'organism_groups' | 'specimen_sites', value: string | null, path: string) => {
    if (value !== null && (await sets.codeRows(tx, { view, tenantId, codes: [value] })).get(value)?.['is_active'] !== true) bad(path);
  };
  await active('organisms', p.organismCode, '/organism_code');
  await active('organism_groups', p.organismGroupCode, '/organism_group_code');
  await active('specimen_sites', p.specimenSiteCode, '/specimen_site_code');
  const known = await sets.codeRows(tx, { view: 'antibiotics', tenantId, codes: [...new Set(p.antibiotics.map((a) => a.antibiotic_code))] });
  for (const [i, a] of p.antibiotics.entries()) if (known.get(a.antibiotic_code)?.['is_active'] !== true) bad(`/antibiotics/${i}/antibiotic_code`);
}

async function writePanel(tx: any, s: { tenantId: string; userId: string }, panelCode: string, versionNo: number, p: PanelInput, onClash: () => never): Promise<Out> {
  try {
    const row = await repo.insertPanel(tx, { ...s, id: uuidv7(), code: panelCode, versionNo, values: { display: p.display, defaultMethod: p.defaultMethod, organismCode: p.organismCode,
      organismGroupCode: p.organismGroupCode, specimenSiteCode: p.specimenSiteCode } });
    const abx = p.antibiotics.map((a, n) => ({ id: uuidv7(), antibioticCode: a.antibiotic_code, sortOrder: n, method: a.method, isReportedDefault: a.is_reported_default }));
    await repo.insertPanelAntibiotics(tx, { ...s, panelId: row['id'], rows: abx });
    const items = abx.map((a) => ({ antibiotic_code: a.antibioticCode, sort_order: a.sortOrder, method: a.method, is_reported_default: a.isReportedDefault }));
    return { body: panelDto(row, items), version: Number(row['version']) };
  } catch (e) {
    if (pgCode(e) === '23505') return onClash();   // a concurrent request won the partial unique index after our pre-checks
    throw e;
  }
}

const panelIdOf = (params: unknown): string => uuid(isObj(params) ? params['panel_id'] : undefined, '/panel_id').toLowerCase();
const flag = (v: unknown, p: string): boolean | undefined => (v === undefined ? undefined : v === true || v === 'true' ? true : v === false || v === 'false' ? false : bad(p));

async function dtosOf(tx: any, tenantId: string, panels: readonly Obj[]): Promise<Obj[]> {
  const abx = await repo.panelAntibiotics(tx, { tenantId, panelIds: panels.map((p) => p['id']) });
  return panels.map((p) => panelDto(p, abx.filter((a) => a['panel_id'] === p['id'])));
}

export async function listAstPanels(c: WriteCtx, input: { query: unknown }): Promise<Obj> {
  const { tx, tenantId } = scope(c);
  const q = isObj(input.query) ? input.query : {};
  const panels = await repo.listPanels(tx, { tenantId, includeSuperseded: flag(q['include_superseded'], '/include_superseded') ?? false,
    organismCode: q['organism_code'] === undefined ? undefined : code(q['organism_code'], '/organism_code'),
    organismGroupCode: q['organism_group_code'] === undefined ? undefined : code(q['organism_group_code'], '/organism_group_code') });
  return { data: await dtosOf(tx, tenantId, panels) };
}

export async function createAstPanel(c: WriteCtx, input: { body: unknown }): Promise<Out> {
  const { tx, tenantId, userId } = scope(c);
  const p = parsePanel(input.body, true);
  await checkRefs(tx, tenantId, p);
  const duplicate = (): never => { throw new LimsError('micro.code_duplicate'); };
  if (await repo.codeTaken(tx, { tenantId, code: p.code! })) duplicate();
  return { ...(await writePanel(tx, { tenantId, userId }, p.code!, 1, p, duplicate)), status: 201 };
}

export async function versionAstPanel(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId } = scope(c);
  const id = panelIdOf(input.params);
  const p = parsePanel(input.body, false);
  const expected = needVersion(input.ifMatch);
  const cur = await repo.getPanel(tx, { tenantId, id, forUpdate: true });   // locked: two concurrent new versions serialise, the loser sees a stale version
  if (!cur) throw new LimsError('common.not_found');
  if (Number(cur['version']) !== expected || cur['superseded_at'] != null) return conflict();
  await checkRefs(tx, tenantId, p);
  if (!(await repo.supersedePanel(tx, { tenantId, userId, id, expectedVersion: expected }))) return conflict();   // v(n) leaves the partial unique index BEFORE v(n+1) is inserted
  return writePanel(tx, { tenantId, userId }, cur['code'], Number(cur['version_no']) + 1, p, conflict);
}

export async function deactivateAstPanel(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId } = scope(c);
  const id = panelIdOf(input.params);
  if (input.body !== undefined && !(isObj(input.body) && Object.keys(input.body).length === 0)) bad('/');
  const expected = needVersion(input.ifMatch);
  const cur = await repo.getPanel(tx, { tenantId, id, forUpdate: true });
  if (!cur) throw new LimsError('common.not_found');
  if (Number(cur['version']) !== expected) return conflict();
  const row = await repo.deactivatePanel(tx, { tenantId, userId, id, expectedVersion: expected });
  if (!row) return conflict();
  return { body: (await dtosOf(tx, tenantId, [row]))[0]!, version: Number(row['version']) };
}
