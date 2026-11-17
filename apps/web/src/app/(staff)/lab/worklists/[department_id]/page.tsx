// SCR worklist of one department (03-APP-FLOW §3.4). The permission list is a UI hint; #18 / #20 enforce it.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { WorklistPage } from '@/features/lab/components/worklists/WorklistPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ department_id: string }> }) {
  const { department_id } = await params;
  if (!UUID.test(department_id)) notFound();
  const session = await getShellSession();
  return <WorklistPage departmentId={department_id} permissions={session?.actor.permissions ?? []} />;
}
