// AU-7 Session expired (public).
import { SessionExpiredCard } from '@/features/admin/auth/SessionExpiredCard';
import { IDLE_MAX_MINUTES } from '@/core/session/policy';

type SP = Record<string, string | string[] | undefined>;
const REASONS = ['locked', 'suspended', 'role_changed'] as const;

export default async function SessionExpiredPage({ searchParams }: { searchParams: Promise<SP> }) {
  const r = (await searchParams).reason;
  const reason = REASONS.find((x) => x === r);
  return (
    <main>
      <SessionExpiredCard minutes={IDLE_MAX_MINUTES} reason={reason} />
    </main>
  );
}
