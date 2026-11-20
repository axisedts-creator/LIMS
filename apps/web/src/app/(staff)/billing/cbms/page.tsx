// 04-UI-UX §8.9 CBMS. No API exposes the client mode yet and only the stub client exists (CR .orchestra/cr/BL-T20.md), so the mode is 'stub'.
// T0D-UILIST-2 (LD-353 rule 6): 501 = NotAvailable with the header row, 500 = ErrorState under the kept title and filters.
import { pendingOr } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { CBMS_COLUMNS, CbmsList } from '@/features/billing/components/CbmsList';
import { readList } from '@/features/billing/components/listRead';
import { listCbmsDocuments } from '@/features/billing/server/read.server';

export default async function CbmsPage() {
  const session = await getShellSession();
  return pendingOr('CBMS', CBMS_COLUMNS, async () => {
    const { value, failure } = await readList(() => listCbmsDocuments({ limit: 100 }));
    return <CbmsList documents={value?.data ?? []} mode="stub" permissions={session?.actor.permissions ?? []} {...(failure ? { failure } : {})} />;
  });
}
