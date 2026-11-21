// T0D-PARTYSET-1 (LD-321; route staff.partners.penalties, permission partners.penalty.manage): ElabAssist Non Compliance penalty master. ?q searches code and name.
import { getShellSession } from '@/core/session/server';
import { PenaltyMaster } from '@/features/partners/components/PenaltyMaster';
import { PermissionNotice } from '@/features/partners/components/common';
import { listNonCompliancePenalties } from '@/features/partners/server/partyset.server';
import { loadFailedText, one, settle } from '@/features/partners/server/sales.server';

export const metadata = { title: 'Penalty Master' };

export default async function PenaltiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('partners.penalty.manage')) return <PermissionNotice />;
  const q = one(sp['q']);
  const list = await settle(listNonCompliancePenalties({ q, cursor: one(sp['cursor']) }));
  const ok = typeof list === 'number' ? undefined : list;
  return <PenaltyMaster rows={ok?.data ?? []} q={q} failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor} />;
}
