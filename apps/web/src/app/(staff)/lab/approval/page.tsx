// 04-UI-UX §3.8 (route /lab/approval). A failed read throws → error.tsx. onStepUp is left to the component default (no C2 step-up route in the spec).
import { getShellSession } from '@/core/session/server';
import { ApprovalQueue } from '@/features/lab/components/ApprovalQueue';
import { listVerificationQueue } from '@/features/lab/server/read.server';

export const metadata = { title: 'Approval' };

export default async function ApprovalPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const items = await listVerificationQueue('approve', sp);
  return <ApprovalQueue items={items} permissions={session?.actor.permissions ?? []} />;
}
