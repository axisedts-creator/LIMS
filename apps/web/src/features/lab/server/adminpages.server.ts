import 'server-only';
// BFF reads for the two lab index pages (ADMINPAGE-LAB-1, LD-255, LD-250): GET /v1/catalog/departments (C3 listDepartments) and GET /v1/lab/critical-values (C5 listCriticalValues).
// Read-only. Only valid filter values reach the API (REQ-SEC-028: no patient or result value in a URL); a failed read throws so error.tsx renders.
import { serverFetch } from '@/core/api/server-fetch';

const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;
export const CRITICAL_STATUSES = ['open', 'notified', 'closed'] as const;
export type CriticalStatus = (typeof CRITICAL_STATUSES)[number];

export interface DepartmentRow { id: string; code: string; name: string; is_active?: boolean }
export interface CriticalValueRow {
  id: string;
  analyte_code: string;
  direction: 'low' | 'high' | 'abnormal';
  status: CriticalStatus;
  detected_at: string;
  closed_at?: string;
}
export interface CriticalValuePage { items: CriticalValueRow[]; nextCursor?: string }

/** Active departments in the order the API returns them (limit 200 is the contract maximum). */
export async function listActiveDepartments(): Promise<DepartmentRow[]> {
  const r = await serverFetch<{ data: DepartmentRow[] }>(`/v1/catalog/departments?${new URLSearchParams({ is_active: 'true', limit: '200' })}`);
  return r.data.filter((d) => d.is_active !== false);
}

export async function listCriticalValues(sp: Record<string, string | string[] | undefined> = {}): Promise<CriticalValuePage> {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const q = new URLSearchParams({ limit: '50' });
  const status = one('status'), cursor = one('cursor');
  if (status && (CRITICAL_STATUSES as readonly string[]).includes(status)) q.set('status', status);
  if (cursor && CURSOR_RE.test(cursor)) q.set('cursor', cursor);
  const r = await serverFetch<{ data: CriticalValueRow[]; page?: { next_cursor?: string } }>(`/v1/lab/critical-values?${q}`);
  return { items: r.data, ...(r.page?.next_cursor ? { nextCursor: r.page.next_cursor } : {}) };
}
