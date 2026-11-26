'use server';
// PHLEBO-UI-FULL-1: approve / reject a phlebotomist application. Returns a plain result: no API body or bearer reaches the browser.
import { ApiError } from '@/core/api/server-fetch';
import { approveApplication, decideApplication } from './applications.server';

export type DecideResult = { ok: true; status?: string; version?: number } | { ok: false; status: number; code: string };

export async function approveApplicationAction(id: string, version: number, roleId: string, centreId: string, key: string): Promise<DecideResult> {
  try {
    return { ok: true, ...(await approveApplication(id, version, roleId, centreId, key)) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}

export async function decideApplicationAction(id: string, version: number, decision: 'approve' | 'reject', note: string | undefined, key: string): Promise<DecideResult> {
  try {
    return { ok: true, ...(await decideApplication(id, version, decision, note, key)) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}
