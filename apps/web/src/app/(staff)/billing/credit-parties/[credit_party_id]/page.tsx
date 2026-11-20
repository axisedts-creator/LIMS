// 04-UI-UX §8.6 detail (route staff.billing.credit_party). T0D-PARTYSET-1 (LD-321): with partners.party_setting.read the Commercial settings tab
// reads the settings of this credit party on its own (a failed read is null: a banner in that tab only).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { CreditPartyDetail } from '@/features/billing/components/CreditPartyDetail';
import { getCreditParty, getCreditPartyStatement, listCreditCharges } from '@/features/billing/server/read.server';
import { getPartyCommercialSetting } from '@/features/partners/server/partyset.server';
import { UUID_RE } from '@/features/partners/server/types';

export default async function CreditPartyPage({ params }: { params: Promise<{ credit_party_id: string }> }) {
  const [{ credit_party_id }, session] = await Promise.all([params, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  const setting = permissions.includes('partners.party_setting.read') && UUID_RE.test(credit_party_id)
    ? getPartyCommercialSetting('credit_party', credit_party_id).catch((e: unknown) => { if (e instanceof ApiError) return null; throw e; })
    : undefined;
  try {
    const [party, charges, statement, commercial] = await Promise.all([getCreditParty(credit_party_id), listCreditCharges(credit_party_id), getCreditPartyStatement(credit_party_id), setting]);
    return <CreditPartyDetail party={party} charges={charges.data} statement={statement.rows} setting={commercial} permissions={permissions} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
