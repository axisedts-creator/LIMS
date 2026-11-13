'use server';
// Server actions for the collect / dispatch / receive screens. Errors become { ok:false, status, code, title }
// because a thrown ApiError loses its code across the action boundary in production. Only ApiError is mapped.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { amendResult, assignException, bulkApproveResults, bulkCollect, bulkDispatch, bulkEnterResults, bulkVerifyResults, createAliquots, discardException, discardSpecimen, lookupSpecimens, reapplyException, receiveSpecimen, rejectSpecimen, requestRecollection, returnResult, storeSpecimen } from './write.server';
import { getAnalyteTrend, getResultHistory, getStatusBoard, listCommentCodes, listOrderResults } from './read.server';
import { UUID_RE } from './types';
import type { ActionResult, AliquotBody, AliquotResult, AmendBody, AssignBody, BoardQuery, BulkItem, BulkRow, CommentCodeRow, DiscardBody, DiscardSpecimenBody, DowntimeFields, EnterEntry, EnterResponse, ExceptionAction, GridResult, HistoryRow, IngestException, LookupKey, OrderResult, RejectBody, RejectResult, ResultBulkRow, ReturnBody, Specimen, StatusBoardPage, StoreBody, TrendResponse, VerifyItem } from './types';

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

export async function reapplyExceptionAction(id: string): Promise<ActionResult<ExceptionAction>> { return run(() => reapplyException(id)); }
export async function discardExceptionAction(id: string, body: DiscardBody): Promise<ActionResult<IngestException>> { return run(() => discardException(id, body)); }
export async function assignExceptionAction(id: string, body: AssignBody, key: string): Promise<ActionResult<ExceptionAction>> { return run(() => assignException(id, body, key)); }
/** Results of an order for the assign dialog (cancelled rows are not offered). Same #listOrderResults read the T-20 grid uses, flattened. */
export async function listOrderResultsAction(orderId: string): Promise<ActionResult<OrderResult[]>> {
  return run(async () => {
    if (!UUID_RE.test(orderId)) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
    return (await listOrderResults(orderId)).items.flatMap((i) => i.results).filter((x) => x.status !== 'cancelled');
  });
}
/** T-27: the board poll / filter change (the JWT stays on the server, REQ-SEC-068). */
export async function getStatusBoardAction(q: BoardQuery): Promise<ActionResult<StatusBoardPage>> { return run(() => getStatusBoard(q)); }
export async function bulkVerifyAction(list: VerifyItem[], key: string): Promise<ActionResult<ResultBulkRow[]>> { return run(() => bulkVerifyResults(list, key)); }
export async function bulkApproveAction(list: VerifyItem[], key: string): Promise<ActionResult<ResultBulkRow[]>> { return run(() => bulkApproveResults(list, key)); }
// C5.T-20 result grid
export async function bulkEnterAction(list: EnterEntry[], key: string, downtime?: DowntimeFields): Promise<ActionResult<EnterResponse>> { return run(() => bulkEnterResults(list, key, downtime)); }
export async function returnResultAction(id: string, version: number, body: ReturnBody): Promise<ActionResult<GridResult>> { return run(() => returnResult(id, version, body)); }
export async function amendResultAction(id: string, version: number, body: AmendBody, key: string): Promise<ActionResult<GridResult>> { return run(() => amendResult(id, version, body, key)); }
export async function getResultHistoryAction(id: string): Promise<ActionResult<HistoryRow[]>> { return run(() => getResultHistory(id)); }
export async function getAnalyteTrendAction(patientId: string, analyteId: string): Promise<ActionResult<TrendResponse>> { return run(() => getAnalyteTrend(patientId, analyteId)); }
export async function listCommentCodesAction(prefix: string): Promise<ActionResult<CommentCodeRow[]>> { return run(() => listCommentCodes(prefix)); }
export async function lookupSpecimenAction(k: LookupKey): Promise<ActionResult<Specimen[]>> { return run(() => lookupSpecimens(k)); }
export async function bulkCollectAction(list: BulkItem[], key: string): Promise<ActionResult<BulkRow[]>> { return run(() => bulkCollect(list, key)); }
export async function bulkDispatchAction(list: BulkItem[], key: string): Promise<ActionResult<BulkRow[]>> { return run(() => bulkDispatch(list, key)); }
export async function receiveSpecimenAction(id: string, version: number, centreId: string, key: string): Promise<ActionResult<Specimen>> { return run(() => receiveSpecimen(id, version, centreId, key)); }
// C5.T-30 specimen detail actions (#12 store, #13 discard, #10 recollect, #11 aliquots)
export async function storeSpecimenAction(id: string, version: number, body: StoreBody, key?: string): Promise<ActionResult<Specimen>> { return run(() => storeSpecimen(id, version, body, key)); }
export async function discardSpecimenAction(id: string, version: number, body: DiscardSpecimenBody, key?: string): Promise<ActionResult<Specimen>> { return run(() => discardSpecimen(id, version, body, key)); }
export async function requestRecollectionAction(id: string, version: number, key: string): Promise<ActionResult<RejectResult>> { return run(() => requestRecollection(id, version, key)); }
export async function createAliquotsAction(id: string, version: number, body: AliquotBody, key: string): Promise<ActionResult<AliquotResult>> { return run(() => createAliquots(id, version, body, key)); }
export async function rejectSpecimenAction(id: string, version: number, body: RejectBody, key: string): Promise<ActionResult<RejectResult>> { return run(() => rejectSpecimen(id, version, body, key)); }
