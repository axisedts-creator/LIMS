'use client';
// Bits shared by the T-23 configuration screens: failure copy (04-UI-UX §8, adapted from anatomic.common.conflict), the Active chip (tone + icon + word), the no-access state,
// the "add" action (header button, or the empty state's action), the standard master-table row button.
// LD-140 (2026-11-13, binding): kit components and token class names only; masters are a list + right Drawer + per-section Save; one primary button per page.
import type { ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import type { TemplateStatus } from '../../server/config.types';
import { Chip, failText, type Fail } from '../common';

import type { DrawerProps } from '@lims/ui/components/Drawer';

export { newKey, type Fail } from '../common';
/** Masters open in the kit right Drawer (via FormDialog, as="drawer"); the assay editor uses the large width. */
export type DrawerWidth = NonNullable<DrawerProps['width']>;
export { MfaDialog } from '../molecular/batch-shared';

/** Failure copy for the configuration forms: the server's own validation message is shown (it names the rule), conflicts and permission use the shared copy. */
export function cfgText(f: Fail): string | undefined {
  switch (f.code) {
    case 'common.version_conflict':
    case 'common.precondition_required':
      return 'This record was changed by someone else. Reload to see the latest version.';
    case 'anatomic.template_invalid':
      return 'The template has errors. Fix the highlighted items.';
    case 'common.immutable_record':
      return "Published templates can't be changed. Create a new version.";
    case 'common.validation_failed':
      return f.detail ?? f.errors?.[0]?.message ?? failText(f);
    default:
      return undefined;
  }
}

export const ActiveChip = ({ active }: { active: boolean }) => (active ? <Chip tone="success" label="Active" size="sm" /> : <Chip tone="neutral" label="Inactive" size="sm" />);

const TEMPLATE_STATUS: Record<TemplateStatus, readonly ['info' | 'success' | 'neutral', string]> = { draft: ['info', 'Draft'], published: ['success', 'Published'], retired: ['neutral', 'Retired'] };
export function TemplateStatusChip({ status }: { status: TemplateStatus }) {
  const [tone, label] = TEMPLATE_STATUS[status] ?? (['neutral', String(status)] as const);
  return <Chip tone={tone} label={label} size="sm" />;
}

export function ConfigForbidden() {
  return (
    <section className="lims-state" aria-labelledby="anatomic-config-forbidden">
      <h1 id="anatomic-config-forbidden" className="lims-state-title">You don&apos;t have permission to change pathology setup</h1>
      <p className="lims-state-body"><a className="lims-link" href="/">Back to home</a></p>
    </section>
  );
}

/** Empty list: an EmptyState whose action opens the drawer. A non-empty list shows the same action above the table (the page's one primary button). */
export function MasterList({ empty, title, addLabel, onAdd, children }: { empty: boolean; title: string; addLabel: string; onAdd: () => void; children: ReactNode }) {
  return empty ? (
    <EmptyState title={title} action={{ label: addLabel, onPress: onAdd }} />
  ) : (
    <>
      <div className="lims-page-actions">
        <Button variant="primary" iconStart="plus" onPress={onAdd}>{addLabel}</Button>
      </div>
      {children}
    </>
  );
}

/** A small positive-integer reader for the sort-order style fields: undefined stays undefined. */
export const asInt = (v: number | undefined, min: number, max: number) => (v !== undefined && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
