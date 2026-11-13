// 04-UI-UX §6.2 Breakpoint set detail — server component via the BFF. Unknown / other-tenant ids (404) and malformed ids (400) → notFound().
// Issues and rows are only read once the file has been checked (uploaded/validating sets have none yet; the client polls and loads them).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { BreakpointSetDetail } from '@/features/micro/components/breakpoints/BreakpointSetDetail';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { getBreakpointSet } from '@/features/micro/server/getBreakpointSet.server';
import { listBreakpointImportIssues } from '@/features/micro/server/listBreakpointImportIssues.server';
import { listBreakpointRows } from '@/features/micro/server/listBreakpointRows.server';
import { orForbidden, orMissing } from '@/features/micro/server/shared';
import { UUID_RE } from '@/features/micro/server/types';

export default async function BreakpointSetPage({ params }: { params: Promise<{ breakpoint_set_id: string }> }) {
  const { breakpoint_set_id } = await params;
  if (!UUID_RE.test(breakpoint_set_id)) notFound();
  const session = await getShellSession();
  const loaded = await orForbidden(() => orMissing(async () => {
    const set = await getBreakpointSet(breakpoint_set_id);
    const checking = set.status === 'uploaded' || set.status === 'validating';
    const [issues, rows] = checking ? [[], []] : await Promise.all([listBreakpointImportIssues(breakpoint_set_id).then((p) => p.data), listBreakpointRows(breakpoint_set_id).then((p) => p.data)]);
    return { set, issues, rows };
  }));
  if (loaded === null) return <MicroForbidden />;
  if (!loaded) notFound();
  return <BreakpointSetDetail set={loaded.set} issues={loaded.issues} rows={loaded.rows} permissions={session?.actor.permissions ?? []} />;
}
