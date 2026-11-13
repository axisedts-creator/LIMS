// 04-UI-UX §6.1 Breakpoint tables — server component via the BFF; 403 → no-access page.
import { getShellSession } from '@/core/session/server';
import { BreakpointSetsScreen } from '@/features/micro/components/breakpoints/BreakpointSetsScreen';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { listBreakpointSets } from '@/features/micro/server/listBreakpointSets.server';
import { orForbidden } from '@/features/micro/server/shared';

export default async function BreakpointSetsPage() {
  const session = await getShellSession();
  const r = await orForbidden(() => listBreakpointSets());
  if (!r) return <MicroForbidden />;
  return <BreakpointSetsScreen sets={r.data} permissions={session?.actor.permissions ?? []} />;
}
