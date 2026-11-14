import 'server-only';
// C10 settings reads/writes for SCR "Micro settings" (TRD §5 M23–M40). Every path part is validated; request bodies are rebuilt from known fields only.
import { serverFetch } from '@/core/api/server-fetch';
import { arrayOf, bad, flag, idemKey, intIn, microCode, oneOf, pick, text, uuid, version } from './shared';
import {
  CODED_SETS, STANDARDS, type AstPanelDto, type AstPanelInput, type CodedSetName, type InstrumentAstDefaultDto, type InstrumentLite, type MicroCodeDto, type MicroCodeInput,
  type MicroSettingsDto, type MicroSettingsInput, type Page, type PlatingProtocolDto, type PlatingProtocolInput, type TestLite, type VocabMapDto, type VocabMapInput,
} from './types';

const JSON_HEADERS = { 'content-type': 'application/json' };
const code = (v: unknown) => microCode(v);
const METHODS = ['mic', 'zone_diameter', 'other'] as const;

export const getMicroSettings = async () => serverFetch<MicroSettingsDto>('/v1/micro/settings');

export async function updateMicroSettings(v: number, input: MicroSettingsInput): Promise<MicroSettingsDto> {
  const body = pick(input, {
    manual_ast_standard: (x) => oneOf(['CLSI', 'EUCAST'] as const, x),
    zone_suggestion_enabled: flag,
    mic_suggestion_enabled: flag,
    default_final_no_growth_hours: intIn(1, 720),
    early_final_requires_reason: flag,
    recent_window_days: intIn(1, 31),
    unset: arrayOf(1, (x) => oneOf(['manual_ast_standard'] as const, x), 1),
  }, ['zone_suggestion_enabled', 'mic_suggestion_enabled', 'default_final_no_growth_hours', 'early_final_requires_reason', 'recent_window_days']);
  return serverFetch<MicroSettingsDto>('/v1/micro/settings', { method: 'PUT', headers: { ...JSON_HEADERS, 'if-match': `"${version(v)}"` }, body: JSON.stringify(body) });
}

// ---- dictionaries
const setName = (v: unknown) => oneOf(CODED_SETS, v);
export const listCodedSet = async (set: string) => serverFetch<{ data: MicroCodeDto[] }>(`/v1/micro/coded-sets/${setName(set)}?include_inactive=true`);

export async function upsertCode(set: string, codeValue: string, input: MicroCodeInput): Promise<MicroCodeDto> {
  const name: CodedSetName = setName(set);
  if (name === 'ast_interpretations') throw bad(); // fixed per standard; the API answers 403 too
  const body = pick(input, {
    display: text(1, 200),
    sort_order: intIn(0, 100000),
    is_active: flag,
    organism_group_code: code,
    gram_class: (x) => oneOf(['gram_positive', 'gram_negative', 'yeast', 'mould', 'other'] as const, x),
    is_alert: flag,
    snomed_ct_concept_id: (x) => { if (typeof x !== 'string' || !/^[0-9]{6,18}$/.test(x)) throw bad(); return x; },
    antibiotic_class: text(1, 64),
    indicates_growth: flag,
    result_flag: (x) => oneOf(['N', 'A'] as const, x),
    requires_isolate: flag,
  }, ['display', 'sort_order', 'is_active']);
  return serverFetch<MicroCodeDto>(`/v1/micro/coded-sets/${name}/codes/${code(codeValue)}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// ---- plating protocols
export const listPlatingProtocols = async () => serverFetch<Page<PlatingProtocolDto> | { data: PlatingProtocolDto[] }>('/v1/micro/plating-protocols');
const protocolSpec = {
  display: text(1, 120),
  read_schedule_hours: arrayOf(10, intIn(1, 720), 1),
  final_no_growth_hours: intIn(1, 720),
  requires_gram_stain: flag,
  default_specimen_site_code: code,
  media: arrayOf(12, (m) => pick(m, { media_code: code, incubation_text: text(1, 120) }, ['media_code'])),
  applies_to: arrayOf(50, (a) => pick(a, { test_id: uuid, specimen_type_code: code })),
};
const PROTOCOL_REQUIRED = ['display', 'read_schedule_hours', 'final_no_growth_hours', 'requires_gram_stain', 'media', 'applies_to'] as const;

export async function createPlatingProtocol(input: PlatingProtocolInput, idempotencyKey: string): Promise<PlatingProtocolDto> {
  const body = pick(input, { code, ...protocolSpec }, ['code', ...PROTOCOL_REQUIRED]);
  return serverFetch<PlatingProtocolDto>('/v1/micro/plating-protocols', { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey) }, body: JSON.stringify(body) });
}
/** "New version": supersedes the current one, the code never changes (the body has no `code`). */
export async function versionPlatingProtocol(id: string, v: number, input: PlatingProtocolInput, idempotencyKey: string): Promise<PlatingProtocolDto> {
  const body = pick(input, protocolSpec, PROTOCOL_REQUIRED);
  return serverFetch<PlatingProtocolDto>(`/v1/micro/plating-protocols/${uuid(id)}/versions`, {
    method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey), 'if-match': `"${version(v)}"` }, body: JSON.stringify(body),
  });
}

// ---- AST panels
export const listAstPanels = async () => serverFetch<Page<AstPanelDto> | { data: AstPanelDto[] }>('/v1/micro/ast-panels');
const panelSpec = {
  display: text(1, 120),
  organism_code: code,
  organism_group_code: code,
  specimen_site_code: code,
  default_method: (x: unknown) => oneOf(METHODS, x),
  antibiotics: arrayOf(60, (a) => pick(a, { antibiotic_code: code, method: (x) => oneOf(METHODS, x), is_reported_default: flag }, ['antibiotic_code', 'is_reported_default']), 1),
};
export async function createAstPanel(input: AstPanelInput, idempotencyKey: string): Promise<AstPanelDto> {
  const body = pick(input, { code, ...panelSpec }, ['code', 'display', 'default_method', 'antibiotics']);
  return serverFetch<AstPanelDto>('/v1/micro/ast-panels', { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey) }, body: JSON.stringify(body) });
}
export async function versionAstPanel(id: string, v: number, input: AstPanelInput, idempotencyKey: string): Promise<AstPanelDto> {
  const body = pick(input, panelSpec, ['display', 'default_method', 'antibiotics']);
  return serverFetch<AstPanelDto>(`/v1/micro/ast-panels/${uuid(id)}/versions`, {
    method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey), 'if-match': `"${version(v)}"` }, body: JSON.stringify(body),
  });
}

// ---- instrument mappings
export const listInstruments = async () => serverFetch<{ data: InstrumentLite[] }>('/v1/instruments/instruments?limit=200');
export const listMicroTests = async () => serverFetch<{ data: TestLite[] }>('/v1/catalog/tests?workflow_type=microbiology&limit=200');
export const listVocabMaps = async (instrumentId: string) => serverFetch<Page<VocabMapDto>>(`/v1/micro/instrument-vocab-maps?instrument_id=${uuid(instrumentId)}&limit=200`);
export async function createVocabMap(input: VocabMapInput, idempotencyKey: string): Promise<VocabMapDto> {
  const body = pick(input, { instrument_id: uuid, kind: (x) => oneOf(['organism', 'antibiotic'] as const, x), code_raw: text(1, 64), local_code: code }, ['instrument_id', 'kind', 'code_raw', 'local_code']);
  return serverFetch<VocabMapDto>('/v1/micro/instrument-vocab-maps', { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey) }, body: JSON.stringify(body) });
}
export const listInstrumentAstDefaults = async () => serverFetch<{ data: InstrumentAstDefaultDto[] }>('/v1/micro/instrument-ast-defaults');
export async function putInstrumentAstDefault(instrumentId: string, input: { standard: string; standard_version: string }, v?: number): Promise<InstrumentAstDefaultDto> {
  const body = pick(input, { standard: (x) => oneOf(STANDARDS, x), standard_version: text(1, 32) }, ['standard', 'standard_version']);
  return serverFetch<InstrumentAstDefaultDto>(`/v1/micro/instrument-ast-defaults/${uuid(instrumentId)}`, {
    method: 'PUT', headers: { ...JSON_HEADERS, ...(v !== undefined ? { 'if-match': `"${version(v)}"` } : {}) }, body: JSON.stringify(body),
  });
}