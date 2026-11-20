// T0D-FINCTRL-1 (LD-321; route staff.billing.discount_slabs): ElabAssist Discount slab per party. Gate = billing.discount_policy.read (routes.yaml).
// Filters come from the URL (API query names party_kind, party_id; invalid values are dropped). ponytail: first 200 slabs (limit=200).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { DiscountSlabsScreen } from '@/features/billing/components/discounts/DiscountSlabsScreen';
import { readList } from '@/features/billing/components/listRead';
import { SLAB_PARTY_KINDS, listPartyDiscountSlabs, listSlabParties, type SlabPartyKind } from '@/features/billing/server/discounts.server';
import { UUID_RE } from '@/features/billing/server/types';

export default async function DiscountSlabsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('billing.discount_policy.read')) notFound();
  const kind = typeof sp['party_kind'] === 'string' && SLAB_PARTY_KINDS.includes(sp['party_kind'] as SlabPartyKind) ? sp['party_kind'] : undefined;
  const party = kind && typeof sp['party_id'] === 'string' && UUID_RE.test(sp['party_id']) ? sp['party_id'] : undefined;
  const filters = { ...(kind ? { party_kind: kind } : {}), ...(party ? { party_id: party } : {}) };
  const [{ value, failure }, parties] = await Promise.all([readList(() => listPartyDiscountSlabs(filters)), listSlabParties()]);
  return <DiscountSlabsScreen slabs={value ?? []} failure={failure} parties={parties} filters={filters} permissions={permissions} />;
}
