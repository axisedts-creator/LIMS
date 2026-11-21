// @vitest-environment jsdom
// T0D-EMPTYTBL-2 — anatomic list screens draw their column headers with no data (LD-310, LD-336; founder 2026-11-17 04:49 NPT).
// Screens: TemplatesTab, TestProfilesTab, BatchesScreen, MolecularTab (editor and read-only). Contract = emptytbl2.helpers.ts (same as T0D-EMPTYTBL-1):
// header row with the real names, message row inside the table body, exactly 4 inert placeholder rows below it, create action in the page header AND the message row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectCreateTwice, expectEmptyTable, expectNoCardOutsideTables, placeholders, tableOf, tablesOf } from './emptytbl2.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/anatomic',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/features/anatomic/server/actions.config', async () => (await import('./emptytbl2.helpers')).stubModuleFactory());
// MolecularTab loads its pickers on mount and chains `.then`: these two must return promises.
vi.mock('@/features/anatomic/server/actions.molecular', () => ({
  listAssaysAction: async () => ({ ok: true, data: [] }),
  listBatchesAction: async () => ({ ok: true, data: [] }),
  saveMolecularResultsAction: vi.fn(),
  createBatchAction: vi.fn(),
}));

import { TemplatesTab } from '@/features/anatomic/components/config/TemplatesTab';
import { TestProfilesTab } from '@/features/anatomic/components/config/TestProfilesTab';
import { BatchesScreen } from '@/features/anatomic/components/molecular/BatchesScreen';
import { MolecularTab } from '@/features/anatomic/components/molecular/MolecularTab';
import type { CaseDetail } from '@/features/anatomic/server/types';
import type { TemplateSummary } from '@/features/anatomic/server/config.types';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);

describe('anatomic TemplatesTab (empty)', () => {
  it('draws Key / Version / Title / Status / Case kinds / Published / Actions, the message and 4 placeholder rows', () => {
    const { container } = wrap(<TemplatesTab templates={[]} />);
    expectEmptyTable(tableOf(container), /No templates yet/, ['Key', 'Version', 'Title', 'Status']);
    expectNoCardOutsideTables(container);
  });
  it('"New template" stays in the page header and is repeated in the message row (link, not button)', () => {
    const { container } = wrap(<TemplatesTab templates={[]} />);
    expectCreateTwice(container, tableOf(container), /^new template$/i, 'link');
  });
  it('with a template there are no placeholder rows and no message', () => {
    const t = { id: 't1', template_key: 'colon-resection', version_no: 1, title: 'Colon resection', status: 'draft', applies_to_case_kinds: ['histology'] } as unknown as TemplateSummary;
    const { container } = wrap(<TemplatesTab templates={[t]} />);
    expect(placeholders(tableOf(container))).toHaveLength(0);
    expect(container.textContent).not.toMatch(/No templates yet/);
  });
});

describe('anatomic TestProfilesTab (empty)', () => {
  it('draws Test / Case kind / … / Active / Actions, the message and 4 placeholder rows', () => {
    const { container } = wrap(<TestProfilesTab profiles={[]} tests={[]} stains={[]} templates={[]} />);
    expectEmptyTable(tableOf(container), /No anatomic or molecular tests/, ['Test', 'Case kind', 'Active']);
    expectNoCardOutsideTables(container);
  });
  it('a catalog test without a profile still lists as "Not configured" with no placeholders', () => {
    const { container } = wrap(<TestProfilesTab profiles={[]} tests={[{ id: 'x1', name: 'HER2 IHC' } as never]} stains={[]} templates={[]} />);
    expect(placeholders(tableOf(container))).toHaveLength(0);
    expect(within(container).getByText('Not configured')).toBeTruthy();
  });
});

describe('anatomic BatchesScreen (empty)', () => {
  const base = { batches: [], assays: [], hasCursor: false } as const;
  it('with work rights: headers + message + 4 placeholder rows; "New batch" once', () => {
    const { container } = wrap(<BatchesScreen {...base} canWork />);
    const t = tableOf(container);
    expectEmptyTable(t, /No batches yet/, ['Batch no', 'Assay', 'Status']);
    expect(within(container).getAllByRole('button', { name: /^new batch$/i })).toHaveLength(1); // LD-353 rules 4, 6
    expectNoCardOutsideTables(container);
  });
  it('without work rights there is no "New batch" button anywhere, but the headers and placeholders are drawn', () => {
    const { container } = wrap(<BatchesScreen {...base} canWork={false} />);
    expectEmptyTable(tableOf(container), /No batches yet/);
    expect(within(container).queryAllByRole('button', { name: /new batch/i })).toHaveLength(0);
  });
  it('a filter with no match says so inside the table and keeps the headers', () => {
    const { container } = wrap(<BatchesScreen {...base} canWork status="open" />);
    expectEmptyTable(tableOf(container), /No batches match these filters/, ['Batch no', 'Assay', 'Status']);
  });
});

const detail = (over: Record<string, unknown> = {}) => ({ id: 'case-1', status: 'in_progress', molecular_rev: 3, molecular_results: [], ...over }) as unknown as CaseDetail;
const noop = () => undefined;
const RESULT = { id: 'r1', assay_code: 'KRAS', target_code: 'G12C', result_code: 'pos', is_abnormal: true, assay_display: 'KRAS panel', target_display: 'G12C', result_display: 'Detected' };

describe('anatomic MolecularTab (empty)', () => {
  it('editor: the 11 assay headers stay, the message is a body row, 4 placeholder rows, Add row and Save stay below', () => {
    const { container } = wrap(<MolecularTab detail={detail()} canWork onFail={noop} onMfa={noop} />);
    const t = tableOf(container);
    expectEmptyTable(t, /No results yet\. Add a row for each assay target\./, ['Assay', 'Target', 'Result', 'Value', 'Unit', 'Method', 'Kit name', 'Kit lot', 'Kit expiry', 'Batch', 'Comment']);
    expectNoCardOutsideTables(container);
    expect(within(container).getByRole('button', { name: /add row/i })).toBeTruthy();
    expect(within(t).queryByRole('button', { name: /add row|save/i }), 'the form buttons are not placeholders').toBeNull();
  });
  it('editor: adding a row replaces the message and the placeholders with one editable row', async () => {
    const { container } = wrap(<MolecularTab detail={detail()} canWork onFail={noop} onMfa={noop} />);
    await userEvent.setup().click(within(container).getByRole('button', { name: /add row/i }));
    const t = tableOf(container);
    expect(placeholders(t)).toHaveLength(0);
    expect(t.textContent).not.toMatch(/No results yet/);
    expect(within(t).getByRole('button', { name: /remove row 1/i })).toBeTruthy();
  });
  it('read-only (no work rights): headers + "No results recorded." + 4 placeholder rows, no Add row / Save', () => {
    const { container } = wrap(<MolecularTab detail={detail()} canWork={false} onFail={noop} onMfa={noop} />);
    expectEmptyTable(tableOf(container), /No results recorded\./, ['Assay', 'Target', 'Result']);
    expectNoCardOutsideTables(container);
    expect(within(container).queryByRole('button', { name: /add row|save/i })).toBeNull();
  });
  it('read-only on a cancelled case is the same table', () => {
    const { container } = wrap(<MolecularTab detail={detail({ status: 'cancelled' })} canWork onFail={noop} onMfa={noop} />);
    expectEmptyTable(tableOf(container), /No results recorded\./);
  });
  it('read-only with a result: the row shows, no message, no placeholder rows', () => {
    const { container } = wrap(<MolecularTab detail={detail({ molecular_results: [RESULT] })} canWork={false} onFail={noop} onMfa={noop} />);
    const t = tableOf(container);
    expect(placeholders(t)).toHaveLength(0);
    expect(t.textContent).toMatch(/KRAS panel/);
    expect(t.textContent).not.toMatch(/No results recorded/);
  });
  it('exactly one table is drawn (the message is not a second block)', () => {
    const { container } = wrap(<MolecularTab detail={detail()} canWork onFail={noop} onMfa={noop} />);
    expect(tablesOf(container)).toHaveLength(1);
    expect(screen.queryAllByText(/No results yet/)).toHaveLength(1);
  });
});
