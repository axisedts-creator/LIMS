'use server';
// Server actions for the T-23 instrument data inbox (TRD §5 M19 listMicroInstrumentRecords, M20 assign, M21 apply, M22 ignore; 04-UI-UX §4; AC-08.4–AC-08.6).
// Errors become { ok:false, status, code } (shared `run`); the bearer JWT never reaches client code (REQ-SEC-068). Every id is validated as a UUID, every list filter is rebuilt from a
// whitelist (REQ-SEC-026/027) and every body from the declared fields only (S-05). Idempotency-Key on assign / apply, If-Match "<record.version>" on all three writes.
// REQ-SEC-098 / AC-08.10: the specimen barcode goes only into the lookup POST body; it is never put in a path or query, never logged. Nothing here logs. S-16: no create path.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { bad, idemKey, intIn, oneOf, pick, run, text, uuid, version } from './shared';
import { listInstruments } from './settings.server';
import { UUID_RE, type ActionResult, type CompareIsolate, type CulturePage, type CultureDetailDto, type InstrumentLite, type InstrumentRecordDto, type InstrumentRecordPage, type InstrumentRecordRow, type RecordResolution, type ScanForAssign } from './types';

type SearchParams = Record<string, string | string[] | undefined>;
const JSON_HEADERS = { 'content-type': 'application/json' };
const STATUSES = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final', 'applied', 'ignored'] as const;
const OPEN = 'pending_match,needs_mapping,conflict,late_after_final'; // 04-UI-UX §4: the default filter is the first four
const ALL = STATUSES.join(',');
const RESOLUTIONS = ['use_instrument', 'keep_existing'] as const satisfies readonly RecordResolution[];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const BARCODE = /^[A-Z0-9]{1,20}$/; // C5 barcode charset (IC §9.3)
const PAGE = 50;

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
const isoUtc = (v: string | undefined) => (v !== undefined && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const ifMatch = (v: unknown) => `"${version(v)}"`;
const statusCsv = (v: string | undefined, fallback: string) => {
  const parts = v === undefined ? [] : v.split(',');
  return parts.length > 0 && parts.every((p) => (STATUSES as readonly string[]).includes(p)) ? parts.join(',') : fallback;
};

/** The list query is rebuilt from validated values; anything else in searchParams (a barcode included) is dropped. */
function listQuery(sp: SearchParams, forCulture?: string): URLSearchParams {
  const q = new URLSearchParams();
  q.set('match_status', statusCsv(one(sp['match_status']), forCulture ? ALL : OPEN));
  q.set('sort', '-received_at');
  q.set('limit', String(PAGE));
  if (forCulture) q.set('culture_id', uuid(forCulture));
  const instrument = one(sp['instrument_id']);
  if (instrument !== undefined && UUID_RE.test(instrument)) q.set('instrument_id', instrument);
  const from = isoUtc(one(sp['received_at_from']));
  if (from) q.set('received_at_from', from);
  const to = isoUtc(one(sp['received_at_to']));
  if (to) q.set('received_at_to', to);
  const cursor = one(sp['cursor']);
  if (cursor !== undefined && CURSOR.test(cursor)) q.set('cursor', cursor);
  return q;
}
const fetchRecords = (q: URLSearchParams) => serverFetch<{ data: InstrumentRecordDto[]; page: { next_cursor?: string } }>(`/v1/micro/instrument-records?${q.toString()}`);
const labelled = (rows: InstrumentRecordDto[], instruments: InstrumentLite[] | null): InstrumentRecordRow[] => {
  const code = new Map((instruments ?? []).map((i) => [i.id, i.code]));
  return rows.map((r) => (code.has(r.instrument_id) ? { ...r, instrument_label: code.get(r.instrument_id)! } : r));
};
const instrumentsOrNull = async (): Promise<InstrumentLite[] | null> => {
  try {
    return (await listInstruments()).data;
  } catch {
    return null; // C7 refused or down: the Instrument filter is hidden, the page still works
  }
};

/** The page's read (M19). Throws ApiError: the page maps 403 to "no access" and lets everything else reach error.tsx. */
export async function listInstrumentRecordsPage(sp: SearchParams): Promise<InstrumentRecordPage> {
  const list = await fetchRecords(listQuery(sp));
  const instruments = await instrumentsOrNull();
  return { rows: labelled(list.data, instruments), ...(list.page.next_cursor ? { nextCursor: list.page.next_cursor } : {}), instruments };
}

/** The culture page tab (04-UI-UX §3.5): every status of this culture, newest first. ponytail: one page of 50; a culture rarely has more, add paging when it does. */
export async function listCultureInstrumentRecordsAction(cultureId: string): Promise<ActionResult<InstrumentRecordRow[]>> {
  return run(async () => {
    const list = await fetchRecords(listQuery({}, cultureId));
    return labelled(list.data, await instrumentsOrNull());
  });
}

/** Conflict dialog: the manual values of the culture the record points at (AC-08.6). Only the fields the comparison shows leave the server. */
export async function getCompareValuesAction(cultureId: string): Promise<ActionResult<CompareIsolate[]>> {
  return run(async () => {
    const c = await serverFetch<CultureDetailDto>(`/v1/micro/cultures/${uuid(cultureId)}`);
    return c.isolates.map((i) => ({
      isolate_seq: i.isolate_seq,
      ...(i.organism_code ? { organism_code: i.organism_code } : {}),
      ...(i.organism_display ? { organism_display: i.organism_display } : {}),
      ast: (i.ast ?? []).map((a) => ({
        antibiotic_code: a.antibiotic_code,
        antibiotic_display: a.antibiotic_display,
        ...(a.raw_value ? { raw_value: a.raw_value } : {}),
        ...(a.category_code ? { category_code: a.category_code } : {}),
        ...(a.standard ? { standard: a.standard } : {}),
        ...(a.standard_version ? { standard_version: a.standard_version } : {}),
      })),
    }));
  });
}

/** Assign dialog scan: C5 lookup (barcode in the POST body only), then the specimen's cultures. S-02: unknown barcode, no culture and a refused lookup all answer `none`. */
export async function findCulturesForAssignAction(barcode: string): Promise<ScanForAssign> {
  if (typeof barcode !== 'string' || !BARCODE.test(barcode)) return { kind: 'none' };
  try {
    const s = await serverFetch<{ id?: unknown }>('/v1/lab/specimens/lookup', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ barcode }) });
    const list = await serverFetch<CulturePage>(`/v1/micro/cultures?specimen_id=${uuid(s.id)}&limit=${PAGE}`);
    const live = list.data.filter((c) => c.status !== 'cancelled').map((c) => ({ id: uuid(c.id), test_code: c.test_code, test_name: c.test_name, status: c.status }));
    return live.length === 0 ? { kind: 'none' } : { kind: 'list', cultures: live };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return { kind: 'none' };
    return { kind: 'error' };
  }
}

// ---- M20 assignMicroInstrumentRecord (Idempotency-Key + If-Match)
export async function assignInstrumentRecordAction(recordId: string, v: number, input: { culture_id: string; isolate_seq: number; resolution?: RecordResolution }, idempotencyKey: string): Promise<ActionResult<InstrumentRecordDto>> {
  return run(() => {
    const rebuilt = pick(input, { culture_id: uuid, isolate_seq: intIn(1, 99), resolution: (x) => oneOf(RESOLUTIONS, x) }, ['culture_id', 'isolate_seq']);
    return serverFetch<InstrumentRecordDto>(`/v1/micro/instrument-records/${uuid(recordId)}/assign`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey), 'if-match': ifMatch(v) },
      body: JSON.stringify(rebuilt),
    });
  });
}

// ---- M21 applyMicroInstrumentRecord (Idempotency-Key + If-Match; `resolution` only for a conflict, AC-08.6)
export async function applyInstrumentRecordAction(recordId: string, v: number, input: { resolution?: RecordResolution }, idempotencyKey: string): Promise<ActionResult<InstrumentRecordDto>> {
  return run(() => {
    const rebuilt = pick(input ?? {}, { resolution: (x) => oneOf(RESOLUTIONS, x) });
    return serverFetch<InstrumentRecordDto>(`/v1/micro/instrument-records/${uuid(recordId)}/apply`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'idempotency-key': idemKey(idempotencyKey), 'if-match': ifMatch(v) },
      body: JSON.stringify(rebuilt),
    });
  });
}

// ---- M22 ignoreMicroInstrumentRecord (If-Match; the reason is a micro.record_ignore_reasons code the API checks)
export async function ignoreInstrumentRecordAction(recordId: string, v: number, input: { reason_code: string; comment?: string }): Promise<ActionResult<InstrumentRecordDto>> {
  return run(() => {
    const rebuilt = pick(input, { reason_code: (x) => (typeof x === 'string' && /^[a-z0-9_]{2,64}$/.test(x) ? x : bad()), comment: text(1, 300) }, ['reason_code']);
    return serverFetch<InstrumentRecordDto>(`/v1/micro/instrument-records/${uuid(recordId)}/ignore`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'if-match': ifMatch(v) },
      body: JSON.stringify(rebuilt),
    });
  });
}
