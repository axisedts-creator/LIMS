'use server';
// C5 T-26 server actions (BFF): #18 listWorklistItems, #19 listPendingItems, #20 createWorksheet, #21 listWorksheets, #22 getWorksheet + C7 E23 listInstruments (names only).
// Errors become { ok:false, status, code, requestId } (a thrown ApiError loses its code across the action boundary). Ids / enums are checked before any network call.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import type { ActionResult, InstrumentOption, Page, PendingItem, WorklistItem, Worksheet, WorksheetSummary } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const id = e.problem.request_id;
    return { ok: false, status: e.status, code: e.problem.code, ...(typeof id === 'string' ? { requestId: id } : {}) };
  }
}
const qs = (p: URLSearchParams) => (p.size ? `?${p.toString()}` : '');

export async function listWorklistAction(q: { departmentId: string; priority?: string; instrumentId?: string }): Promise<ActionResult<Page<WorklistItem>>> {
  if (!UUID.test(q.departmentId) || (q.instrumentId !== undefined && !UUID.test(q.instrumentId)) || (q.priority !== undefined && !/^[A-Za-z0-9_]{1,32}$/.test(q.priority))) return bad();
  const p = new URLSearchParams({ department_id: q.departmentId });
  if (q.priority) p.set('priority', q.priority);
  if (q.instrumentId) p.set('instrument_id', q.instrumentId);
  return run(() => serverFetch<Page<WorklistItem>>(`/v1/lab/worklist-items${qs(p)}`));
}

export async function listPendingAction(q: { overTarget?: boolean } = {}): Promise<ActionResult<Page<PendingItem>>> {
  const p = new URLSearchParams();
  if (q.overTarget) p.set('over_target', 'true');
  return run(() => serverFetch<Page<PendingItem>>(`/v1/lab/pending-items${qs(p)}`));
}

export async function createWorksheetAction(body: { title: string; department_id?: string; instrument_id?: string; order_test_ids: string[] }, idempotencyKey: string): Promise<ActionResult<Worksheet>> {
  if (!KEY.test(idempotencyKey) || body.order_test_ids.length < 1 || body.order_test_ids.length > 200 || !body.order_test_ids.every((i) => UUID.test(i))) return bad();
  const title = body.title.trim();
  if (title.length < 1 || title.length > 80) return bad();
  const safe = { title, order_test_ids: body.order_test_ids, ...(body.department_id && UUID.test(body.department_id) ? { department_id: body.department_id } : {}), ...(body.instrument_id && UUID.test(body.instrument_id) ? { instrument_id: body.instrument_id } : {}) };
  return run(() => serverFetch<Worksheet>('/v1/lab/worksheets', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(safe) }));
}

export async function getWorksheetAction(worksheetId: string): Promise<ActionResult<Worksheet>> {
  if (!UUID.test(worksheetId)) return { ok: false, status: 404, code: 'common.not_found' };
  return run(() => serverFetch<Worksheet>(`/v1/lab/worksheets/${worksheetId}`));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;

/** #21 listWorksheets (lab.yaml: created_at_from/to, department_id, cursor). */
export async function listWorksheetsAction(q: { createdAtFrom?: string; createdAtTo?: string; departmentId?: string; cursor?: string } = {}): Promise<ActionResult<Page<WorksheetSummary>>> {
  if ((q.createdAtFrom !== undefined && !ISO.test(q.createdAtFrom)) || (q.createdAtTo !== undefined && !ISO.test(q.createdAtTo))
    || (q.departmentId !== undefined && !UUID.test(q.departmentId)) || (q.cursor !== undefined && !CURSOR.test(q.cursor))) return bad();
  const p = new URLSearchParams();
  if (q.createdAtFrom) p.set('created_at_from', q.createdAtFrom);
  if (q.createdAtTo) p.set('created_at_to', q.createdAtTo);
  if (q.departmentId) p.set('department_id', q.departmentId);
  if (q.cursor) p.set('cursor', q.cursor);
  return run(() => serverFetch<Page<WorksheetSummary>>(`/v1/lab/worksheets${qs(p)}`));
}

/** C7 E23 via the BFF: display names only, never from lab.yaml (08 A13 D-14). 403 => the caller hides the filter / shows IdText. */
export async function listInstrumentsAction(): Promise<ActionResult<InstrumentOption[]>> {
  return run(async () => (await serverFetch<Page<InstrumentOption>>('/v1/instruments/instruments?limit=200')).data.map((i) => ({ id: i.id, display_name: i.display_name })));
}
