// C13.T19 PU-1 Users — /users (04-UI-UX PU-1; partner_admin only). The list is not requested at all without partners.partner_user.manage (404, nothing rendered); the API enforces it again.
// U1 listPartnerUsers: 403 auth.mfa_required redirects to /auth/mfa inside partnerApi.
import { notFound } from 'next/navigation';
import { can, getList, getMe, query, type Search } from '@/features/common/api';
import type { PartnerUser } from '@/features/common/types';
import { UserList } from '@/features/users/UserList';

const RULES = { status: { csv: ['invited', 'active', 'deactivated'] }, cursor: 'cursor' } as const;

export default async function UsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const me = await getMe();
  if (!can(me, 'partners.partner_user.manage')) notFound();
  const list = await getList<PartnerUser>(`/v1/partners/users${query(await searchParams, RULES)}`);
  return <UserList rows={list.data} nextCursor={list.page?.next_cursor} />;
}
