// SP-2 Partner detail + SP-3 users (04-UI-UX §4). Partner 404 -> not-found; 5xx propagates to error.tsx. The tab reads settle on their own (banner in that tab).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { getPartner, listManifests, listPartnerUsers, listReferrers } from '@/features/partners/server/read.server';
import { UUID_RE } from '@/features/partners/server/types';
import { PartnerDetail } from '@/features/partners/components/PartnerDetail';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partner' };

const settle = async <T,>(p: Promise<{ data: T[] }> | null): Promise<T[] | null> => {
  if (!p) return null;
  try {
    return (await p).data;
  } catch (e) {
    if (e instanceof ApiError) return null;
    throw e;
  }
};

export default async function PartnerPage({ params }: { params: Promise<{ partner_id: string }> }) {
  const [{ partner_id }, session] = await Promise.all([params, getShellSession()]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('partners.partner.read')) return <PermissionNotice />;
  if (!UUID_RE.test(partner_id)) notFound();
  const [partner, users, manifests, referrers] = await Promise.all([
    getPartner(partner_id).catch((e: unknown) => { if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound(); throw e; }),
    settle(listPartnerUsers(partner_id)),
    settle(perms.includes('partners.manifest.receive') ? listManifests({ partner_id }) : null),
    settle(perms.includes('partners.referrer.map') ? listReferrers({ partner_id }) : null),
  ]);
  return <PartnerDetail partner={partner} users={users} manifests={manifests} referrers={referrers} permissions={perms} />;
}
