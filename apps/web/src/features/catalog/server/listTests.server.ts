import 'server-only';
// #23 listTests (cursor paging). The cursor is opaque; only a conservative charset is passed through.
import { serverFetch } from '@/core/api/server-fetch';

export interface TestSummary { id: string; code: string; name: string; workflow_type?: string; is_orderable?: boolean; is_active: boolean }
const CURSOR_RE = /^[A-Za-z0-9_\-=.]{1,512}$/;

export async function listTests(cursor?: string): Promise<{ data: TestSummary[]; page: { next_cursor?: string } }> {
  const q = new URLSearchParams({ limit: '50', sort: 'code' });
  if (cursor && CURSOR_RE.test(cursor)) q.set('cursor', cursor);
  return serverFetch(`/v1/catalog/tests?${q}`);
}
