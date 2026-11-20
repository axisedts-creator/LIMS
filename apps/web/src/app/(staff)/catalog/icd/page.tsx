// T0D-PARTYSET-1 (LD-321; route staff.catalog.icd, permission catalog.icd.manage): ElabAssist ICD master. ?q searches code prefix and title; ?cursor pages.
import { getShellSession } from '@/core/session/server';
import { IcdMaster } from '@/features/catalog/components/IcdMaster';
import { PermissionNotice } from '@/features/partners/components/common';
import { listIcdMasterCodes } from '@/features/catalog/server/icd.server';
import { loadFailedText, one, settle } from '@/features/partners/server/sales.server';

export const metadata = { title: 'ICD Master' };

export default async function IcdMasterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('catalog.icd.manage')) return <PermissionNotice />;
  const q = one(sp['q']);
  const list = await settle(listIcdMasterCodes({ q, cursor: one(sp['cursor']) }));
  const ok = typeof list === 'number' ? undefined : list;
  return <IcdMaster rows={ok?.data ?? []} q={q} failed={ok ? undefined : loadFailedText(list as number)} nextCursor={ok?.page.next_cursor} />;
}
