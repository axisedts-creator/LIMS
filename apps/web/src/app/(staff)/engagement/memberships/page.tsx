// W10 Memberships (04-UI-UX §3 W10). M1a plans + the C3 price lists (names only) are read here; lookup, enrol, cancel and plan writes are server actions.
import 'server-only';
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { listPriceLists } from '@/features/catalog/server/listPriceLists.server';
import { searchPatientsAction } from './actions';
import { listPlans } from './memberships.server';
import { MembershipsView } from './MembershipsView';

const READ = 'engagement.membership.read';

/** Price list names are a convenience: without catalog access the plans still show (the list column falls back to a dash). */
async function priceLists() {
  try {
    return (await listPriceLists({ isActive: 'all', limit: 200 })).data.map((l) => ({ id: l.id, display: l.name }));
  } catch (e) {
    if (e instanceof ApiError) return [];
    throw e;
  }
}

export default async function MembershipsPage() {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes(READ)) notFound();
  const [plans, lists] = await Promise.all([listPlans(), priceLists()]);
  return <MembershipsView plans={Array.isArray(plans?.data) ? plans.data : []} priceLists={lists} permissions={permissions} searchPatients={searchPatientsAction} />;
}
