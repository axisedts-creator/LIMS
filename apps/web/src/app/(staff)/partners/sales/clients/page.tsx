// T0D-SALES-1 (LD-321; route staff.partners.sales_clients): ElabAssist Sales Client List. listRepresentativeClients is per representative, so the page reads
// the representatives (one page of 200, inactive included: they keep open assignments until moved) and asks one clients call each, or only the one in
// ?representative_id. ?party_kind is passed on when it is a known kind; any other value and a malformed id are ignored.
// ponytail: one call per representative; a tenant-wide client list operation (CR) replaces the fan-out when representatives run into the hundreds.
import { getShellSession } from '@/core/session/server';
import { isKind, isUuid, listPartyOptions, listRepresentativeClients, listSalesRepresentatives, loadFailedText, one, settle } from '@/features/partners/server/sales.server';
import { SalesClients, type ClientRow } from '@/features/partners/components/SalesClients';

export const metadata = { title: 'Sales Client List' };

const NO_PARTIES = { credit_party: [], partner: [], doctor: [], referrer: [] };

export default async function SalesClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const permissions = session?.actor.permissions ?? [];
  const repId = one(sp['representative_id']);
  const kind = one(sp['party_kind']);
  const representativeId = isUuid(repId) ? repId : undefined;
  const partyKind = isKind(kind) ? kind : undefined;
  const list = permissions.includes('partners.sales.read') ? await settle(listSalesRepresentatives({}, 200)) : 403;
  const reps = typeof list === 'number' ? [] : list.data;
  // a representative past the first 200 is still asked when named in the URL
  const asked = representativeId ? (reps.some((r) => r.id === representativeId) ? reps.filter((r) => r.id === representativeId) : typeof list === 'number' ? [] : [{ id: representativeId, name: '—' }]) : reps;
  const [reads, parties] = await Promise.all([
    Promise.all(asked.map((r) => settle(listRepresentativeClients(r.id, partyKind)))),
    permissions.includes('partners.sales.manage') ? listPartyOptions() : NO_PARTIES,
  ]);
  const rows: ClientRow[] = reads.flatMap((p, i) => (typeof p === 'number' ? [] : p.data.map((c) => ({ ...c, representative_id: asked[i]!.id, representative_name: asked[i]!.name }))));
  return (
    <SalesClients
      rows={rows} reps={reps} parties={parties} failed={typeof list === 'number' ? loadFailedText(list) : undefined} partial={reads.some((p) => typeof p === 'number')}
      representativeId={representativeId} partyKind={partyKind} permissions={permissions}
    />
  );
}
