// 04-UI-UX §8.4 Dues.
import { DuesList } from '@/features/billing/components/DuesList';
import { listCentres } from '@/features/billing/server/accounts.server';
import { listDues } from '@/features/billing/server/read.server';

export default async function DuesPage() {
  // LD-446 (CR DEPLOY-AXIS-012 7a): pass the centre list so every row shows the centre name; an unreadable list leaves dashes.
  const [{ data }, centres] = await Promise.all([listDues({ limit: 100 }), listCentres()]);
  return <DuesList dues={data} centres={centres.flatMap((c) => (c.centre_id ?? c.id ? [{ id: (c.centre_id ?? c.id) as string, name: c.name }] : []))} />;
}
