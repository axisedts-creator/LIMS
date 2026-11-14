'use server';
// Server actions for the T-20 culture page (TRD §5 M3–M10): set-up, plates, observations, isolates. A thrown ApiError loses its code across the action
// boundary in production, so errors become { ok:false, status, code } (shared `run`). The bearer JWT never reaches client code (REQ-SEC-068).
// Every id is validated as a UUID and every body is rebuilt from the declared fields only (S-05 strict body; REQ-SEC-026/027); the API re-checks everything.
// Idempotency-Key where the contract says `required`; If-Match "<version>" where the call takes one. Nothing here logs a body (REQ-SEC-098).
import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { arrayOf, bad, idemKey, microCode, oneOf, pick, run, text, uuid, version } from './shared';
import { OBSERVATION_KINDS, type ActionResult, type CultureDetailDto, type IsolateDescribeInput, type IsolateDto, type IsolateInput, type MicroCodeDto, type ObservationDto, type ObservationInput, type PlateDto, type PlateInput, type SetupInput } from './types';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isoUtc = (v: unknown) => {
  if (typeof v !== 'string' || !ISO_UTC_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad();
  return v;
};
const ifMatch = (v: unknown) => `"${version(v)}"`;
const post = <T>(path: string, body: unknown, extra: Record<string, string> = {}) =>
  serverFetch<T>(path, { method: 'POST', headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) });

// ---- setup (M3) and plates (M4, M5)
export async function setupCultureAction(cultureId: string, v: number, input: SetupInput, idempotencyKey: string): Promise<ActionResult<CultureDetailDto>> {
  return run(() => {
    const body = pick(input, {
      plating_protocol_id: uuid,
      specimen_site_code: microCode,
      planted_at: isoUtc,
      plates: arrayOf(12, (p) => pick(p, { media_code: microCode, incubation_text: text(1, 120) }, ['media_code']), 1),
    }, ['planted_at', 'plates']);
    return post<CultureDetailDto>(`/v1/micro/cultures/${uuid(cultureId)}/setup`, body, { 'idempotency-key': idemKey(idempotencyKey), 'if-match': ifMatch(v) });
  });
}
export async function addPlateAction(cultureId: string, input: PlateInput, idempotencyKey: string): Promise<ActionResult<PlateDto>> {
  return run(() => {
    const body = pick(input, { media_code: microCode, incubation_text: text(1, 120), parent_plate_id: uuid, source_isolate_id: uuid, planted_at: isoUtc }, ['media_code']);
    return post<PlateDto>(`/v1/micro/cultures/${uuid(cultureId)}/plates`, body, { 'idempotency-key': idemKey(idempotencyKey) });
  });
}
export async function discardPlateAction(cultureId: string, plateId: string, v: number): Promise<ActionResult<PlateDto>> {
  return run(() => post<PlateDto>(`/v1/micro/cultures/${uuid(cultureId)}/plates/${uuid(plateId)}/discard`, {}, { 'if-match': ifMatch(v) }));
}

// ---- observations (M6)
export async function recordObservationAction(cultureId: string, input: ObservationInput, idempotencyKey: string): Promise<ActionResult<{ observation: ObservationDto }>> {
  return run(() => {
    const body = pick(input, {
      kind: (k) => oneOf(OBSERVATION_KINDS, k),
      plate_id: uuid,
      growth_code: microCode,
      quantity_text: text(1, 80),
      finding_text: text(1, 2000),
      observed_at: isoUtc,
      corrects_observation_id: uuid,
    }, ['kind']);
    return post<{ observation: ObservationDto }>(`/v1/micro/cultures/${uuid(cultureId)}/observations`, body, { 'idempotency-key': idemKey(idempotencyKey) });
  });
}

// ---- isolates (M7–M10)
export async function createIsolateAction(cultureId: string, input: IsolateInput, idempotencyKey: string): Promise<ActionResult<IsolateDto>> {
  return run(() => {
    const body = pick(input, { plate_id: uuid, colony_description: text(1, 500), quantity_text: text(1, 80), organism_code: microCode });
    return post<IsolateDto>(`/v1/micro/cultures/${uuid(cultureId)}/isolates`, body, { 'idempotency-key': idemKey(idempotencyKey) });
  });
}
export async function identifyIsolateAction(isolateId: string, v: number, organismCode: string): Promise<ActionResult<IsolateDto>> {
  return run(() => post<IsolateDto>(`/v1/micro/isolates/${uuid(isolateId)}/identify`, { organism_code: microCode(organismCode) }, { 'if-match': ifMatch(v) }));
}
/** Full replace (omitted optional fields are cleared): the caller sends everything that should stay. */
export async function describeIsolateAction(isolateId: string, v: number, input: IsolateDescribeInput): Promise<ActionResult<IsolateDto>> {
  return run(() => {
    const body = pick(input, { colony_description: text(1, 500), quantity_text: text(1, 80), is_reportable: (x) => { if (typeof x !== 'boolean') throw bad(); return x; }, plate_id: uuid }, ['is_reportable']);
    return post<IsolateDto>(`/v1/micro/isolates/${uuid(isolateId)}/describe`, body, { 'if-match': ifMatch(v) });
  });
}
export async function withdrawIsolateAction(isolateId: string, v: number, input: { reason_code: string; comment?: string }): Promise<ActionResult<IsolateDto>> {
  return run(() => {
    const body = pick(input, { reason_code: microCode, comment: text(1, 500) }, ['reason_code']);
    return post<IsolateDto>(`/v1/micro/isolates/${uuid(isolateId)}/withdraw`, body, { 'if-match': ifMatch(v) });
  });
}

// ---- reads for the dialogs (GET /v1/micro/coded-sets/{set}); the set name and the search text are validated before they reach the URL.
const SET = ['organisms', 'media', 'specimen_sites', 'growth_codes', 'isolate_withdraw_reasons', 'ast_interpretations'] as const; // ast_interpretations: T-21 grid categories
/** Prefix search (organisms) — 1..40 characters, as the contract says. */
export async function searchCodedSetAction(set: string, q: string): Promise<ActionResult<MicroCodeDto[]>> {
  return run(async () => {
    const name = oneOf(SET, set);
    const query = text(1, 40)(q);
    return (await serverFetch<{ data: MicroCodeDto[] }>(`/v1/micro/coded-sets/${name}?q=${encodeURIComponent(query)}`)).data;
  });
}
/** The whole set, including retired codes (so a retired medium still shows its name on an old plate); dialogs hide inactive codes. */
export async function listCultureCodesAction(set: string): Promise<ActionResult<MicroCodeDto[]>> {
  return run(async () => (await serverFetch<{ data: MicroCodeDto[] }>(`/v1/micro/coded-sets/${oneOf(SET, set)}?include_inactive=true`)).data);
}
