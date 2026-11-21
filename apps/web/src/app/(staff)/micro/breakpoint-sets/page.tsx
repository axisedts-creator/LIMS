// 04-UI-UX §6.1 Breakpoint tables — server component via the BFF; 403 → no-access page.
// T0D-UILIST-1, LD-353 rule 6: 501 operation_pending → NotAvailable with the header row (title = menu name, rule 8).
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { pendingOr } from '@/core/shell/NotAvailable';
import { BreakpointSetsScreen } from '@/features/micro/components/breakpoints/BreakpointSetsScreen';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { listBreakpointSets } from '@/features/micro/server/listBreakpointSets.server';
import { orForbidden } from '@/features/micro/server/shared';

const COLUMNS = ['Title', 'Standard', 'Version', 'Status', 'Effective from', 'Effective to', 'Rows', 'Errors', 'Imported by', 'Imported at'] as const;

export default function BreakpointSetsPage() {
  return pendingOr(t('micro.nav.breakpoint_sets'), COLUMNS, async () => {
    const session = await getShellSession();
    const r = await orForbidden(() => listBreakpointSets());
    if (!r) return <MicroForbidden helpKey="micro.breakpoint_sets" />;
    return <BreakpointSetsScreen sets={r.data} permissions={session?.actor.permissions ?? []} />;
  });
}
