// 04-UI-UX §3.8 (route /lab/verification). A failed read throws → error.tsx (an empty list would say "Nothing waiting" while results wait).
import { getShellSession } from '@/core/session/server';
import { VerificationQueue } from '@/features/lab/components/VerificationQueue';
import { listVerificationQueue } from '@/features/lab/server/read.server';

export const metadata = { title: 'Verification' };

export default async function VerificationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const items = await listVerificationQueue('verify', sp);
  return <VerificationQueue items={items} permissions={session?.actor.permissions ?? []} />;
}
