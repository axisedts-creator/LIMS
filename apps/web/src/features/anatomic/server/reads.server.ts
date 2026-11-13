import 'server-only';
// C11 reads for the T-19 screens (contracts/openapi/anatomic.yaml). Bearer JWT is added by serverFetch; ids are validated before they reach a path.
// LD-140 (2026-11-13): no UI in this file.
import { serverFetch } from '@/core/api/server-fetch';
import type { WorklistQuery } from './worklistQuery';
import { uuid } from './shared';
import type { Assignee, CaseDetail, CaseSummary, CodedValue, LookupResult, Page, TextTemplate } from './types';

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
