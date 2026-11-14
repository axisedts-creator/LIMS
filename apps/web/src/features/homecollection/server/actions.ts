'use server';
// Server actions for the dispatch dialogs. Only ApiError is mapped to { ok:false, status, code, pointers? } (a thrown ApiError loses its code across the
// action boundary in production); anything else rethrows to the error boundary. Nothing but a status string / version / a phlebotomist list goes back:
// never a request body, a token or a server detail.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import type { HandoverDetail, PhlebotomistOption, ScheduleBody, SettingsBody } from '../types';
import { getHandover, listPhlebotomists } from './read.server';
import { assignVisit, cancelVisit, confirmHandover, resequenceRoute, saveSettings, scheduleVisit, unassignVisit, wipeDevice } from './write.server';

export type ActionResult =
  | { ok: true; status?: string; version?: number }
  | { ok: false; status: number; code: string; pointers?: string[] };

const POINTER = /^\/[a-z0-9_/]{1,80}$/;
function failure(e: unknown): ActionResult {
  if (!(e instanceof ApiError)) throw e;
  const errs = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { pointer?: unknown; path?: unknown }[]) : [];
  const pointers = errs.map((x) => (typeof x?.pointer === 'string' ? x.pointer : typeof x?.path === 'string' ? x.path : '')).filter((p) => POINTER.test(p));
  return { ok: false, status: e.status, code: e.problem.code, ...(pointers.length ? { pointers } : {}) };
}
async function run(call: () => Promise<{ status?: string; version?: number } | undefined>): Promise<ActionResult> {
  try {
    const r = await call();
    return { ok: true, ...(typeof r?.status === 'string' ? { status: r.status } : {}), ...(typeof r?.version === 'number' && Number.isSafeInteger(r.version) ? { version: r.version } : {}) };
  } catch (e) {
    return failure(e);
  }
}

export async function scheduleAction(id: string, version: number, body: ScheduleBody, key: string): Promise<ActionResult> {
  return run(() => scheduleVisit(id, version, body, key));
}
export async function assignAction(id: string, version: number, body: { membershipId: string; routeDate: string; position?: number }, key: string): Promise<ActionResult> {
  return run(() => assignVisit(id, version, body, key));
}
export async function unassignAction(id: string, version: number, reasonCode: string, reasonText: string | undefined, key: string): Promise<ActionResult> {
  return run(() => unassignVisit(id, version, reasonCode, reasonText, key));
}
export async function cancelAction(id: string, version: number, reasonCode: string, reasonText: string | undefined, key: string): Promise<ActionResult> {
  return run(() => cancelVisit(id, version, reasonCode, reasonText, key));
}
export async function resequenceAction(id: string, version: number, visitIds: string[]): Promise<ActionResult> {
  return run(() => resequenceRoute(id, version, visitIds));
}

/** H15 confirmHandover. */
export async function confirmHandoverAction(id: string, version: number, items: { specimen_id: string; received: boolean }[], key: string): Promise<ActionResult> {
  return run(() => confirmHandover(id, version, items, key));
}
/** H17 requestDeviceWipe. */
export async function wipeDeviceAction(id: string, version: number, reasonCode: string, reasonText: string | undefined, key: string): Promise<ActionResult> {
  return run(() => wipeDevice(id, version, reasonCode, reasonText, key));
}
/** H19 updateHomecollectionSettings. */
export async function saveSettingsAction(version: number, body: SettingsBody): Promise<ActionResult> {
  return run(() => saveSettings(version, body));
}

export type HandoverResult = { ok: true; data: HandoverDetail } | { ok: false; status: number; code: string };
/** H14 for the handover drawer. */
export async function handoverAction(id: string): Promise<HandoverResult> {
  try {
    return { ok: true, data: await getHandover(id) };
  } catch (e) {
    const f = failure(e);
    return f.ok ? { ok: false, status: 500, code: 'common.internal' } : { ok: false, status: f.status, code: f.code };
  }
}

export type PhlebotomistsResult = { ok: true; data: PhlebotomistOption[] } | { ok: false; status: number; code: string };
/** H12 for the Assign dialog. */
export async function phlebotomistsAction(centreId: string, routeDate: string): Promise<PhlebotomistsResult> {
  try {
    return { ok: true, data: await listPhlebotomists(centreId, routeDate) };
  } catch (e) {
    const f = failure(e);
    return f.ok ? { ok: false, status: 500, code: 'common.internal' } : { ok: false, status: f.status, code: f.code };
  }
}
