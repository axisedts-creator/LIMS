import 'server-only';
// C11 reads for the T-19 screens (contracts/openapi/anatomic.yaml). Bearer JWT is added by serverFetch; ids are validated before they reach a path.
// LD-140 (2026-11-13): no UI in this file.
import { serverFetch } from '@/core/api/server-fetch';
import type { WorklistQuery } from './worklistQuery';
import { uuid } from './shared';
import type { Assignee, BlockRow, CaseDetail, CaseSummary, CodedValue, LabelItem, LookupResult, Movement, Page, Stain, TextTemplate } from './types';

/** listAnatomicCases (A1). Page size 50; the server orders urgent first, oldest first (the UI never re-sorts). */
export const listCases = (q: WorklistQuery) => {
  const p = new URLSearchParams({ queue: q.queue, limit: '50', ...q.params });
  return serverFetch<Page<CaseSummary>>(`/v1/anatomic/cases?${p.toString()}`);
};

/** getAnatomicCase (A3). */
export const getCase = (caseId: string) => serverFetch<CaseDetail>(`/v1/anatomic/cases/${uuid(caseId)}`);

/** listAnatomicTextTemplates (K20): gross templates only; the page passes them down (client-side `;code` expansion, 04-UI-UX §2). */
export const listGrossTemplates = async () => (await serverFetch<{ data: TextTemplate[] }>('/v1/anatomic/text-templates?section=gross')).data;

/** lookupAnatomicObject (A2): the label travels in the body, never in the URL or a log (REQ-SEC-098). */
export const lookupLabel = (label: string) => {
  if (!/^[A-Z0-9-]{1,32}$/.test(label)) throw new Error('label');
  return serverFetch<LookupResult>('/v1/anatomic/cases/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
};

/** listAnatomicAssignees (A12): `case_id` restricts to the case centre; `q` is a staff-name search. */
export const listAssignees = async (caseId: string, q: string) => {
  const p = new URLSearchParams({ case_id: uuid(caseId), q: q.slice(0, 60), limit: '20' });
  return (await serverFetch<{ data: Assignee[] }>(`/v1/anatomic/assignees?${p.toString()}`)).data;
};

/** listAnatomicCodedValues (K11) for the cancel reasons. */
export const listCancelReasons = async () => (await serverFetch<{ data: CodedValue[] }>('/v1/anatomic/coded-sets/cancel_reasons/values')).data;

/** listAnatomicStains (K3): active stains; the order dialog offers special + IHC, the default stain picker is routine (04-UI-UX §4.2.3-4). */
export const listStains = async () => (await serverFetch<{ data: Stain[] }>('/v1/anatomic/stains')).data;

/** listAnatomicCodedValues (K11) for the cytology adequacy picker. */
export const listAdequacy = async () => (await serverFetch<{ data: CodedValue[] }>('/v1/anatomic/coded-sets/cytology_adequacy/values')).data;

/** listAnatomicBlockMovements / listAnatomicSlideMovements (M13/M14): the full history of one block or slide, by id. */
export const listMovements = async (kind: 'block' | 'slide', id: string) =>
  (await serverFetch<{ data: Movement[] }>(`/v1/anatomic/${kind === 'block' ? 'blocks' : 'slides'}/${uuid(id)}/movements`)).data;

/** listAnatomicBlocks (M12) for the "Sent out" tab. */
export const listSentOutBlocks = () => serverFetch<Page<BlockRow>>('/v1/anatomic/blocks?location_status=sent_out&limit=50');

/** getAnatomicLabels (M15): the API writes the `anatomic_label.print` access-log row when it serves this call; only `kind` and `ids` travel in the URL (REQ-SEC-098). */
export const getLabels = async (caseId: string, kind: 'blocks' | 'slides', ids?: string) => {
  const p = new URLSearchParams({ kind, ...(ids ? { ids } : {}) });
  return (await serverFetch<{ labels: LabelItem[] }>(`/v1/anatomic/cases/${uuid(caseId)}/labels?${p.toString()}`)).labels;
};
