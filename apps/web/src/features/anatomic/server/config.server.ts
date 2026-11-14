import 'server-only';
// C11 T-23 reads and writes for the configuration screens (K1-K13, K17-K22; contracts/openapi/anatomic.yaml). Ids are validated (REQ-SEC-026/027), bodies are rebuilt field by
// field against the contract (additionalProperties: false; display fields are never echoed back), PUT carries the row version in If-Match and no Idempotency-Key, POST carries one.
// The API validator (T-03) stays the authority for synoptic definitions; this layer only forwards declared fields. LD-140 (2026-11-13): no UI in this file.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { bad, idemKey, ifMatch, jsonInit, uuid } from './shared';
import type {
  AssayInput, AssayRecord, CatalogTest, CodedInput, CodedRow, CodedSet, Definition, DefField, Settings, SettingsInput, StainCreate, StainRecord, StainUpdate, SynopticTemplate,
  TemplateStatus, TemplateSummary, TestProfile, TestProfileInput, TextTemplateCreate, TextTemplateRecord, TextTemplateUpdate,
} from './config.types';
import { CODED_SETS } from './config.types';

const API = '/v1/anatomic';
const STAIN_CODE = /^[A-Z0-9_]{1,32}$/;
const RESULT_CODE = /^[a-z0-9_]{1,32}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DECIMAL = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;
const CODED_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SHORT_CODE = /^[a-z0-9_]{1,16}$/;
const KINDS = ['histology', 'cytology', 'ihc', 'molecular'] as const;
const FIELD_TYPES = ['text', 'long_text', 'integer', 'decimal', 'boolean', 'single_select', 'multi_select', 'date'];

const match = (v: unknown, re: RegExp) => {
  if (typeof v !== 'string' || !re.test(v)) throw bad();
  return v;
};
const text = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad();
  return v;
};
const int = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw bad();
  return v;
};
const oneOf = <T extends string>(v: unknown, set: readonly T[]) => {
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) throw bad();
  return v as T;
};
/** Empty optional strings are omitted, never sent as "". */
const put = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));
const optText = (v: unknown, max: number) => (v === undefined || v === '' ? undefined : text(v, 1, max));
const optMatch = (v: unknown, re: RegExp) => (v === undefined || v === '' ? undefined : match(v, re));
const get = async <T>(path: string) => serverFetch<T>(`${API}${path}`);
const list = async <T>(path: string) => (await get<{ data: T[] }>(path)).data;

// ---------------------------------------------------------------- reads
export const getSettings = () => get<Settings>('/settings');
/** K3: `include_inactive=true` for the Stains table; the Settings picker asks for routine stains (the UI filters active ones again). */
export const listAllStains = () => list<StainRecord>('/stains?include_inactive=true');
export const listRoutineStains = () => list<StainRecord>('/stains?kind=routine');
export const listActiveStains = () => list<StainRecord>('/stains');
export const listTestProfiles = () => list<TestProfile>('/test-profiles');
export const listAllAssays = () => list<AssayRecord>('/assays?include_inactive=true');
export const listAllTextTemplates = () => list<TextTemplateRecord>('/text-templates?include_inactive=true');
/** K11: only the three sets C11 owns (change / amendment reasons are C5); anything else falls back to diagnoses upstream. */
export const listCodedValues = (set: CodedSet) => list<CodedRow>(`/coded-sets/${oneOf(set, CODED_SETS)}/values?include_inactive=true`);
/** K13: all statuses unless one is asked for. */
export const listSynoptic = (status?: TemplateStatus) => list<TemplateSummary>(`/synoptic-templates${status ? `?status=${oneOf(status, ['draft', 'published', 'retired'] as const)}` : ''}`);
export const getSynoptic = (id: string) => get<SynopticTemplate>(`/synoptic-templates/${uuid(id)}`);

/** catalog.test.read through the BFF (C3 HTTP list): anatomic and molecular tests. A failure is not fatal: the profiles that exist are still listed. */
export async function listProfileTests(): Promise<CatalogTest[]> {
  const one = async (workflow: 'anatomic' | 'molecular') => {
    try {
      // ponytail: first page only (50 per workflow type, as the catalog screens); add cursor paging if a lab has more anatomic tests than that.
      return (await serverFetch<{ data: CatalogTest[] }>(`/v1/catalog/tests?workflow_type=${workflow}&limit=50&sort=code`)).data;
    } catch (e) {
      if (e instanceof ApiError) return [];
      throw e;
    }
  };
  const [a, m] = await Promise.all([one('anatomic'), one('molecular')]);
  return [...a, ...m];
}

// ---------------------------------------------------------------- writes
export function saveSettings(version: number, s: SettingsInput) {
  const body = {
    auto_accession_on_receipt: bool(s.auto_accession_on_receipt),
    require_gross_complete_for_processing: bool(s.require_gross_complete_for_processing),
    default_routine_stain_code: match(s.default_routine_stain_code, STAIN_CODE),
    max_images_per_case: int(s.max_images_per_case, 1, 200),
    max_report_images: int(s.max_report_images, 0, 24),
  };
  return serverFetch<Settings>(`${API}/settings`, jsonInit('PUT', body, { 'if-match': ifMatch(version) }));
}

export function createStain(s: StainCreate, key: string) {
  const body = {
    code: match(s.code, STAIN_CODE),
    display: text(s.display, 1, 120),
    kind: oneOf(s.kind, ['routine', 'special', 'ihc'] as const),
    sort_order: int(s.sort_order, 0, 9999),
    ...put('addon_test_id', s.addon_test_id === undefined ? undefined : uuid(s.addon_test_id)),
  };
  return serverFetch<StainRecord>(`${API}/stains`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}
export function updateStain(id: string, version: number, s: StainUpdate) {
  const body = {
    display: text(s.display, 1, 120),
    kind: oneOf(s.kind, ['routine', 'special', 'ihc'] as const),
    sort_order: int(s.sort_order, 0, 9999),
    is_active: bool(s.is_active),
    ...put('addon_test_id', s.addon_test_id === undefined ? undefined : uuid(s.addon_test_id)),
  };
  return serverFetch<StainRecord>(`${API}/stains/${uuid(id)}`, jsonInit('PUT', body, { 'if-match': ifMatch(version) }));
}

/** K7: If-Match "0" creates the profile. */
export function saveTestProfile(testId: string, version: number, p: TestProfileInput) {
  const keys = p.default_synoptic_template_keys;
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > 5)) throw bad();
  const body = {
    case_kind: oneOf(p.case_kind, KINDS),
    is_addon: bool(p.is_addon),
    requires_gross: bool(p.requires_gross),
    is_active: bool(p.is_active),
    ...put('default_stain_code', optMatch(p.default_stain_code, STAIN_CODE)),
    ...(keys ? { default_synoptic_template_keys: keys.map((k) => match(k, KEY)) } : {}),
  };
  return serverFetch<TestProfile>(`${API}/test-profiles/${uuid(testId)}`, jsonInit('PUT', body, { 'if-match': ifMatch(version) }));
}

function assayBody(a: AssayInput) {
  if (!Array.isArray(a.targets) || a.targets.length < 1 || a.targets.length > 50) throw bad();
  return {
    code: match(a.code, STAIN_CODE),
    display: text(a.display, 1, 120),
    ...put('method_text_default', optText(a.method_text_default, 200)),
    is_active: bool(a.is_active),
    targets: a.targets.map((t) => {
      if (!Array.isArray(t.result_values) || t.result_values.length < 1 || t.result_values.length > 20) throw bad();
      return {
        code: match(t.code, STAIN_CODE),
        display: text(t.display, 1, 120),
        allows_quantitative: bool(t.allows_quantitative),
        ...put('unit_code', optText(t.unit_code, 32)),
        ...put('decimals', t.decimals === undefined ? undefined : int(t.decimals, 0, 6)),
        sort_order: int(t.sort_order, 0, 9999),
        is_active: bool(t.is_active),
        result_values: t.result_values.map((v) => ({
          code: match(v.code, RESULT_CODE), display: text(v.display, 1, 120), is_abnormal: bool(v.is_abnormal), sort_order: int(v.sort_order, 0, 9999), is_active: bool(v.is_active),
        })),
      };
    }),
  };
}
export const createAssay = (a: AssayInput, key: string) => serverFetch<AssayRecord>(`${API}/assays`, jsonInit('POST', assayBody(a), { 'idempotency-key': idemKey(key) }));
export const updateAssay = (id: string, version: number, a: AssayInput) =>
  serverFetch<AssayRecord>(`${API}/assays/${uuid(id)}`, jsonInit('PUT', assayBody(a), { 'if-match': ifMatch(version) }));

/** K12: PUT creates (If-Match "0") or updates a code of one of the three sets. */
export function saveCodedValue(set: CodedSet, code: string, version: number, c: CodedInput) {
  const body = {
    display: text(c.display, 1, 300),
    system: text(c.system, 1, 32),
    ...put('system_version', optText(c.system_version, 32)),
    sort_order: int(c.sort_order, 0, 9999),
    is_active: bool(c.is_active),
  };
  return serverFetch<CodedRow>(`${API}/coded-sets/${oneOf(set, CODED_SETS)}/values/${match(code, CODED_CODE)}`, jsonInit('PUT', body, { 'if-match': ifMatch(version) }));
}

export function createTextTemplate(t: TextTemplateCreate, key: string) {
  const body = {
    short_code: match(t.short_code, SHORT_CODE),
    section: oneOf(t.section, ['gross', 'microscopy', 'impression', 'comment', 'addendum'] as const),
    title: text(t.title, 1, 120),
    body: text(t.body, 1, 8000),
  };
  return serverFetch<TextTemplateRecord>(`${API}/text-templates`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}
export function updateTextTemplate(id: string, version: number, t: TextTemplateUpdate) {
  const body = { title: text(t.title, 1, 120), body: text(t.body, 1, 8000), is_active: bool(t.is_active) };
  return serverFetch<TextTemplateRecord>(`${API}/text-templates/${uuid(id)}`, jsonInit('PUT', body, { 'if-match': ifMatch(version) }));
}

// ---- synoptic templates
function fieldBody(f: DefField) {
  const type = oneOf(f.type, FIELD_TYPES as readonly DefField['type'][]);
  return {
    key: match(f.key, KEY),
    label: text(f.label, 1, 200),
    type,
    required: bool(f.required),
    ...put('help_text', optText(f.help_text, 500)),
    ...put('unit_text', optText(f.unit_text, 20)),
    ...put('min', optMatch(f.min, DECIMAL)),
    ...put('max', optMatch(f.max, DECIMAL)),
    ...put('decimals', f.decimals === undefined ? undefined : int(f.decimals, 0, 6)),
    ...put('max_length', f.max_length === undefined ? undefined : int(f.max_length, 1, 4000)),
    ...(f.options ? { options: f.options.map((o) => ({ code: text(o.code, 1, 64), display: text(o.display, 1, 200) })) } : {}),
    ...(f.show_if ? { show_if: { field_key: match(f.show_if.field_key, KEY), equals: typeof f.show_if.equals === 'boolean' ? f.show_if.equals : text(f.show_if.equals, 1, 64) } } : {}),
  };
}
function definitionBody(d: Definition) {
  if (d.schema_version !== 1 || !Array.isArray(d.sections) || d.sections.length > 20 || !Array.isArray(d.applies_to_case_kinds)) throw bad();
  return {
    schema_version: 1 as const,
    title: text(d.title, 1, 200),
    applies_to_case_kinds: d.applies_to_case_kinds.map((k) => oneOf(k, KINDS)),
    sections: d.sections.map((s) => {
      if (!Array.isArray(s.fields) || s.fields.length > 60) throw bad();
      return { key: match(s.key, KEY), heading: text(s.heading, 1, 200), fields: s.fields.map(fieldBody) };
    }),
  };
}
export const createSynoptic = (templateKey: string, d: Definition, key: string) =>
  serverFetch<SynopticTemplate>(`${API}/synoptic-templates`, jsonInit('POST', { template_key: match(templateKey, KEY), definition: definitionBody(d) }, { 'idempotency-key': idemKey(key) }));
export const updateSynoptic = (id: string, version: number, d: Definition) =>
  serverFetch<SynopticTemplate>(`${API}/synoptic-templates/${uuid(id)}`, jsonInit('PUT', { definition: definitionBody(d) }, { 'if-match': ifMatch(version) }));
/** Publish / Retire: the list rows carry no row version, so the current one is read first and used in If-Match (a stale row then fails on the API). */
export async function transitionSynoptic(id: string, op: 'publish' | 'retire', key: string) {
  const current = await getSynoptic(id);
  return serverFetch<SynopticTemplate>(`${API}/synoptic-templates/${uuid(id)}/${op}`, { method: 'POST', headers: { 'if-match': ifMatch(current.version), 'idempotency-key': idemKey(key) } });
}
export const newSynopticVersion = (id: string, key: string) =>
  serverFetch<SynopticTemplate>(`${API}/synoptic-templates/${uuid(id)}/new-version`, { method: 'POST', headers: { 'idempotency-key': idemKey(key) } });
