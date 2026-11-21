// 04-UI-UX §4.1 Worklist — server component via the BFF; 403 → no-access state; any other failure → NotAvailable / ErrorState in the page (T0D-UILIST-1).
// LD-140 (2026-11-13): screens are built from the kit only (see WorklistScreen).
import { getShellSession } from '@/core/session/server';
import { loadOr } from '@/core/shell/NotAvailable';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { WorklistScreen } from '@/features/anatomic/components/WorklistScreen';
import { listCases } from '@/features/anatomic/server/reads.server';
import { orForbidden } from '@/features/anatomic/server/shared';
import { parseWorklistQuery } from '@/features/anatomic/server/worklistQuery';

const COLUMNS = ['Accession', 'Patient', 'Kind', 'Tests', 'Parts', 'Received', 'Priority', 'Status', 'Pathologist'];

export default async function WorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseWorklistQuery(await searchParams);
  const session = await getShellSession();
  // T0D-UILIST-1 (LD-353 rule 6): 501 operation_pending → NotAvailable with the header row, a 500 → ErrorState in the page; never error.tsx.
  return loadOr('Pathology cases', COLUMNS, async () => {
    const r = await orForbidden(() => listCases(query));
    if (!r) return <AnatomicForbidden />;
    return <WorklistScreen queue={query.queue} cases={r.data} {...(r.page.next_cursor ? { nextCursor: r.page.next_cursor } : {})} permissions={session?.actor.permissions ?? []} />;
  });
}
