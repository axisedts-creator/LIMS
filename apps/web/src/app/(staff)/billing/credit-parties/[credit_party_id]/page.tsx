// 04-UI-UX §8.6 detail (route staff.billing.credit_party).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { CreditPartyDetail } from '@/features/billing/components/CreditPartyDetail';
import { getCreditParty, getCreditPartyStatement, listCreditCharges } from '@/features/billing/server/read.server';

export default async function CreditPartyPage({ params }: { params: Promise<{ credit_party_id: string }> }) {
  const { credit_party_id } = await params;
  try {
    const [party, charges, statement] = await Promise.all([getCreditParty(credit_party_id), listCreditCharges(credit_party_id), getCreditPartyStatement(credit_party_id)]);
    return <CreditPartyDetail party={party} charges={charges.data} statement={statement.rows} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
