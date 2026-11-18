// 04-UI-UX §4.6 Batches list — server component via the BFF. Only a known status and a well-formed assay code reach the API (REQ-SEC-027); without anatomic.case.read
// there is no API call; 403 → no-access state; any other failure → NotAvailable / ErrorState in the page (T0D-UILIST-1). LD-140 (2026-11-13): screens are built from the kit only (see BatchesScreen).
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { BatchesScreen } from '@/features/anatomic/components/molecular/BatchesScreen';
import { listAssays, listBatches } from '@/features/anatomic/server/molecular.server';
import { orForbidden } from '@/features/anatomic/server/shared';
import type { BatchQuery, BatchStatus } from '@/features/anatomic/server/types';

const COLUMNS = ['Batch no', 'Assay', 'Status', 'Kit lot', 'Run at', 'Members / capacity'];
type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

function parse(sp: Params): BatchQuery {
  const status = first(sp['status']);
  const assay = first(sp['assay_code']);
  const cursor = first(sp['cursor']);
  return {
    ...(status === 'open' || status === 'closed' ? { status: status as BatchStatus } : {}),
    ...(assay && /^[A-Z0-9_]{1,32}$/.test(assay) ? { assay_code: assay } : {}),
    ...(cursor && /^[A-Za-z0-9_.~=-]{1,512}$/.test(cursor) ? { cursor } : {}),
  };
}

export default async function BatchesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const query = parse(await searchParams);
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('anatomic.case.read')) return <AnatomicForbidden />;
  // T0D-UILIST-1 (LD-353 rule 6): 501 operation_pending → NotAvailable with the header row, other failures still reject to error.tsx (t22.batches pins it; done_when 6 names only the landing).
  return pendingOr('Molecular batches', COLUMNS, async () => {
    const r = await orForbidden(() => listBatches(query));
    if (!r) return <AnatomicForbidden />;
    // The filter and the New batch dialog need the assays; a failing list leaves them empty, it never breaks the page.
    const assays = await listAssays().catch(() => []);
    return (
      <BatchesScreen
        batches={r.data}
        assays={assays}
        canWork={permissions.includes('anatomic.case.work')}
        {...(query.status ? { status: query.status } : {})}
        {...(query.assay_code ? { assayCode: query.assay_code } : {})}
        {...(r.page.next_cursor ? { nextCursor: r.page.next_cursor } : {})}
        hasCursor={query.cursor !== undefined}
      />
    );
  });
}
