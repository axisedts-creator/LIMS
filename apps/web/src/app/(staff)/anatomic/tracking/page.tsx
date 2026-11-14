// 04-UI-UX §4.5 Tracking — server component via the BFF. No anatomic.case.read → no-access state and no API call; 403 → no-access state; other failures reject to error.tsx.
// The "Sent out" tab is read here (blocks + each block's movements for destination and reason); the lookup tab is driven by the client screen.
// LD-140 (2026-11-13): screens are built from the kit only (see TrackingScreen).
import { getShellSession } from '@/core/session/server';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { TrackingScreen, type SentOutRow } from '@/features/anatomic/components/tracking/TrackingScreen';
import { listMovements, listSentOutBlocks } from '@/features/anatomic/server/reads.server';
import { orForbidden } from '@/features/anatomic/server/shared';

export default async function TrackingPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab: raw } = await searchParams;
  const tab = raw === 'sent_out' ? 'sent_out' : 'lookup'; // anything else is the Lookup tab and calls nothing
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('anatomic.case.read')) return <AnatomicForbidden />;

  let sentOut: SentOutRow[] = [];
  if (tab === 'sent_out') {
    const blocks = await orForbidden(() => listSentOutBlocks());
    if (!blocks) return <AnatomicForbidden />;
    // ponytail: one movements call per sent-out block (page size 50); the API has no destination column on BlockRow. Add one if this list grows.
    sentOut = await Promise.all(
      blocks.data.map(async (block) => {
        const last = (await listMovements('block', block.id).catch(() => [])).filter((m) => m.movement === 'sent_out').sort((a, b) => b.at.localeCompare(a.at))[0];
        return { block, ...(last?.destination_text ? { destination: last.destination_text } : {}), ...(last?.reason_code ? { reason: last.reason_code } : {}) };
      }),
    );
  }
  return <TrackingScreen tab={tab} canWork={permissions.includes('anatomic.case.work')} sentOut={sentOut} />;
}
