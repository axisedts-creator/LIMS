// T0D-PARTYSET-1 (LD-321; route staff.partners.penalty_events, permission partners.penalty.manage): non compliance penalty events with Raise, Waive and Charge.
// ?status (raised, waived, charged), ?from_date and ?to_date (YYYY-MM-DD) are passed on when well formed. The party and penalty names come from their lists.
import { getShellSession } from '@/core/session/server';
import { PenaltyEvents } from '@/features/partners/components/PenaltyEvents';
import { PermissionNotice } from '@/features/partners/components/common';
import { listAllPenalties, listNonComplianceEvents } from '@/features/partners/server/partyset.server';
import { listPartyOptions, loadFailedText, one, settle } from '@/features/partners/server/sales.server';

export const metadata = { title: 'Penalty Events' };

export default async function PenaltyEventsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('partners.penalty.manage')) return <PermissionNotice />;
  const filter = { status: one(sp['status']), from_date: one(sp['from_date']), to_date: one(sp['to_date']) };
  const [list, penalties, parties] = await Promise.all([
    settle(listNonComplianceEvents({ ...filter, cursor: one(sp['cursor']) })),
    settle(listAllPenalties()),
    listPartyOptions(),
  ]);
  const ok = typeof list === 'number' ? undefined : list;
  return (
    <PenaltyEvents rows={ok?.data ?? []} penalties={typeof penalties === 'number' ? [] : penalties.data} parties={parties} filter={filter}
      failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor} />
  );
}
