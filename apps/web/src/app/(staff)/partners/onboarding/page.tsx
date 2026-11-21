// T0D-PARTYSET-1 (LD-321; route staff.partners.onboarding, permission partners.onboarding.decide): ElabAssist franchise approval queue.
// No ?status = the default queue (pending); ?status= (empty) = all; any other value than the four statuses is ignored.
import { getShellSession } from '@/core/session/server';
import { OnboardingQueue } from '@/features/partners/components/OnboardingQueue';
import { PermissionNotice } from '@/features/partners/components/common';
import { listPartyOnboarding } from '@/features/partners/server/partyset.server';
import { loadFailedText, one, settle } from '@/features/partners/server/sales.server';

export const metadata = { title: 'Onboarding Queue' };
const STATUSES = ['', 'pending', 'held', 'approved', 'rejected'];

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('partners.onboarding.decide')) return <PermissionNotice />;
  const raw = one(sp['status']);
  const status = raw !== undefined && STATUSES.includes(raw) ? raw : 'pending';
  const list = await settle(listPartyOnboarding({ status, cursor: one(sp['cursor']) }));
  const ok = typeof list === 'number' ? undefined : list;
  return <OnboardingQueue rows={ok?.data ?? []} status={status} failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor} />;
}
