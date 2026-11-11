'use server';
// Server actions for the collect / dispatch / receive screens. Errors become { ok:false, status, code, title }
// because a thrown ApiError loses its code across the action boundary in production. Only ApiError is mapped.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { bulkApproveResults, bulkCollect, bulkDispatch, bulkVerifyResults, lookupSpecimens, receiveSpecimen, rejectSpecimen } from './write.server';
import type { ActionResult, BulkItem, BulkRow, LookupKey, RejectBody, RejectResult, ResultBulkRow, Specimen, VerifyItem } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const p = e.problem;
      return { ok: false, status: e.status, code: p.code, title: p.title, ...(typeof p['detail'] === 'string' ? { detail: p['detail'] } : {}) };
    }
    throw e;
  }
}

export async function bulkVerifyAction(list: VerifyItem[], key: string): Promise<ActionResult<ResultBulkRow[]>> { return run(() => bulkVerifyResults(list, key)); }
export async function bulkApproveAction(list: VerifyItem[], key: string): Promise<ActionResult<ResultBulkRow[]>> { return run(() => bulkApproveResults(list, key)); }
export async function lookupSpecimenAction(k: LookupKey): Promise<ActionResult<Specimen[]>> { return run(() => lookupSpecimens(k)); }
export async function bulkCollectAction(list: BulkItem[], key: string): Promise<ActionResult<BulkRow[]>> { return run(() => bulkCollect(list, key)); }
export async function bulkDispatchAction(list: BulkItem[], key: string): Promise<ActionResult<BulkRow[]>> { return run(() => bulkDispatch(list, key)); }
export async function receiveSpecimenAction(id: string, version: number, centreId: string, key: string): Promise<ActionResult<Specimen>> { return run(() => receiveSpecimen(id, version, centreId, key)); }
export async function rejectSpecimenAction(id: string, version: number, body: RejectBody, key: string): Promise<ActionResult<RejectResult>> { return run(() => rejectSpecimen(id, version, body, key)); }
