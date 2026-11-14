// SP-1 Partners (04-UI-UX §4). A failing list read shows a banner, never a stale or empty table; branches/centres feed the New partner dialog (manage only).
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { listBranchesAction, listCentresAction } from '@/features/partners/server/actions';
import { listPartners } from '@/features/partners/server/read.server';
import { PartnersList } from '@/features/partners/components/PartnersList';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partners' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PartnersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('partners.partner.read')) return <PermissionNotice />;
  const canManage = perms.includes('partners.partner.manage');
  const filters = { status: one(sp['status']), q: one(sp['q']) };
  const [list, branches, centres] = await Promise.all([
    listPartners(filters).catch((e: unknown) => { if (e instanceof ApiError) return null; throw e; }),
    canManage ? listBranchesAction() : null,
    canManage ? listCentresAction() : null,
  ]);
  return <PartnersList rows={list?.data ?? []} failed={list === null} canManage={canManage} branches={branches?.ok ? branches.data : []} centres={centres?.ok ? centres.data : []} filters={filters} />;
}
