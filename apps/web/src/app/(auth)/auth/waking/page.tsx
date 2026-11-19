// T0D-WAKE-1 (LD-277, RS-07): middleware rewrites a document here when the API gave no answer. Public; reads no session.
import { WakingState } from '@/features/admin/auth/WakingState';

export default function WakingPage() {
  return (
    <main>
      <WakingState />
    </main>
  );
}
