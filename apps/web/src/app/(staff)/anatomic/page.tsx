// 04-UI-UX §4.1 Worklist — server component via the BFF; 403 → no-access state; any other failure rejects to error.tsx.
// LD-140 (2026-11-13): screens are built from the kit only (see WorklistScreen).
import { getShellSession } from '@/core/session/server';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { WorklistScreen } from '@/features/anatomic/components/WorklistScreen';
import { listCases } from '@/features/anatomic/server/reads.server';
import { orForbidden } from '@/features/anatomic/server/shared';
import { parseWorklistQuery } from '@/features/anatomic/server/worklistQuery';

export default async function WorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseWorklistQuery(await searchParams);
  const session = await getShellSession();
  const r = await orForbidden(() => listCases(query));
  if (!r) return <AnatomicForbidden />;
  return <WorklistScreen queue={query.queue} cases={r.data} {...(r.page.next_cursor ? { nextCursor: r.page.next_cursor } : {})} permissions={session?.actor.permissions ?? []} />;
}
