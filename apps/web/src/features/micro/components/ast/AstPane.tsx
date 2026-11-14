'use client';
// The AST half of the "Isolates & AST" tab (04-UI-UX §3.3): what the selected isolate shows. LD-140 (2026-11-13): kit components only.
//   nothing selected -> a hint; not identified -> no grid (assignAstPanel needs an identified isolate); identified without a panel -> "Choose AST panel" (worker only);
//   identified with a panel -> the grid, once the tenant standard is known. The grid is keyed by the isolate: values typed for one isolate never show up on another.
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Inline } from '@lims/ui/components/Inline';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';
import { Stack } from '@lims/ui/components/Stack';
import type { IsolateDto } from '../../server/types';
import { AstGrid } from './AstGrid';
import type { TenantStandard } from './useTenantStandard';

export interface AstPaneProps {
  isolate: IsolateDto | undefined;
  /** micro.culture.work and a culture state that allows writes. */
  canWork: boolean;
  tenant: TenantStandard;
  /** Alt+A asked for focus: the grid takes the request (clears it) as soon as its table is there. */
  focusRequest?: { current: boolean };
  onChoosePanel: (i: IsolateDto) => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

/** True when the pane shows the grid for this isolate (the tenant standard is only read then). */
export const showsGrid = (i: IsolateDto | undefined): i is IsolateDto => !!i && i.status !== 'pending_id' && !!i.ast_panel;

export function AstPane({ isolate, canWork, tenant, focusRequest, onChoosePanel, onSaved, onDirtyChange }: AstPaneProps) {
  if (!isolate) return <EmptyState title="Select an isolate to see its AST results." />;
  if (isolate.status === 'pending_id') return <EmptyState title="Identify the isolate before recording AST results." />;
  if (!isolate.ast_panel) {
    if (isolate.status === 'withdrawn') return <EmptyState title="This isolate was withdrawn. It has no AST results." />;
    // The kit EmptyState action is a primary button; the page already has one, so this is a secondary button beside the hint.
    return (
      <Stack gap={2}>
        <EmptyState title="No AST panel is chosen for this isolate yet." />
        {canWork ? (
          <Inline gap={2}>
            <Button variant="secondary" onPress={() => onChoosePanel(isolate)}>
              Choose AST panel
            </Button>
          </Inline>
        ) : null}
      </Stack>
    );
  }
  if (!tenant.loaded) return <LoadingSkeleton variant="table" rows={3} />;
  return (
    <AstGrid
      key={isolate.id}
      isolate={isolate}
      canWork={canWork}
      {...(tenant.standard ? { defaultStandard: tenant.standard } : {})}
      {...(focusRequest ? { focusRequest } : {})}
      onSaved={onSaved}
      onDirtyChange={onDirtyChange}
    />
  );
}
