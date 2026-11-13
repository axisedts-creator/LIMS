// SF-1 Partner doctors (04-UI-UX §4, US-13.3): lists not-yet-confirmed doctors unless the URL says otherwise.
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { listReferrers } from '@/features/partners/server/read.server';
import { ReferrerMapping } from '@/features/partners/components/ReferrerMapping';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partner doctors' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReferrersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('partners.referrer.map')) return <PermissionNotice />;
  const mapping_state = one(sp['mapping_state']) ?? 'unmapped';
  const list = await listReferrers({ mapping_state, partner_id: one(sp['partner_id']) }).catch((e: unknown) => { if (e instanceof ApiError) return null; throw e; });
  return <ReferrerMapping rows={list?.data ?? []} failed={list === null} filters={{ mapping_state }} />;
}
