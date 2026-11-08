// 04-UI-UX §8.4 Dues.
import { DuesList } from '@/features/billing/components/DuesList';
import { listDues } from '@/features/billing/server/read.server';

export default async function DuesPage() {
  const { data } = await listDues({ limit: 100 });
  return <DuesList dues={data} />;
}
