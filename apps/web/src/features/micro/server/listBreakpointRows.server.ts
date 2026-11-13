import 'server-only';
// listBreakpointRows (GET …/breakpoint-sets/{set_id}/rows). Needs micro.breakpoint.manage. Filters are validated, never forwarded raw.
import { serverFetch } from '@/core/api/server-fetch';
import { microCode, uuid } from './shared';
import type { BreakpointRowDto, Page } from './types';

export async function listBreakpointRows(id: string, q: { antibioticCode?: string; organismCode?: string; limit?: number } = {}) {
  const p = new URLSearchParams({ limit: String(q.limit ?? 200) });
  if (q.antibioticCode !== undefined) p.set('antibiotic_code', microCode(q.antibioticCode));
  if (q.organismCode !== undefined) p.set('organism_code', microCode(q.organismCode));
  return serverFetch<Page<BreakpointRowDto>>(`/v1/micro/breakpoint-sets/${uuid(id)}/rows?${p}`);
}
