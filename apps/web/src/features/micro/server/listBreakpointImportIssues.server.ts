import 'server-only';
// listBreakpointImportIssues (GET …/breakpoint-sets/{set_id}/issues, sort line_no). Needs micro.breakpoint.manage.
import { serverFetch } from '@/core/api/server-fetch';
import { oneOf, uuid } from './shared';
import type { BreakpointImportIssueDto, Page } from './types';

export async function listBreakpointImportIssues(id: string, q: { severity?: 'error' | 'warning'; limit?: number } = {}) {
  const p = new URLSearchParams({ limit: String(q.limit ?? 200) });
  if (q.severity !== undefined) p.set('severity', oneOf(['error', 'warning'], q.severity));
  return serverFetch<Page<BreakpointImportIssueDto>>(`/v1/micro/breakpoint-sets/${uuid(id)}/issues?${p}`);
}
