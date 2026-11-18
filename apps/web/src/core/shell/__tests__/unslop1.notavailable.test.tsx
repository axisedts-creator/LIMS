// @vitest-environment jsdom
// T0D-UNSLOP-1 (A) — the calm "Not available yet" state (LD-353 rule 6: an operation that is not built yet, 501 operation_pending, shows NotAvailable,
// never a red error page). Contract pinned here (names are the tester's; recorded in .orchestra/notes/T0D-UNSLOP-1-tests.md):
//   apps/web/src/core/shell/NotAvailable.tsx   export function NotAvailable({ title, columns }: { title: string; columns?: readonly string[] })
//   - an <h1> with `title` (the page keeps its menu title);
//   - the words "Not available yet" and ONE hint line; no role="alert", no Retry button, no reference / request id (it is not a failure);
//   - when `columns` is given: a table whose column headers are exactly `columns`, in order (the header row of the screen stays).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NotAvailable } from '@/core/shell/NotAvailable';

afterEach(cleanup);

describe('NotAvailable', () => {
  it('keeps the page title as the h1 and says Not available yet', () => {
    render(<NotAvailable title="Stock" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Stock' })).toBeTruthy();
    expect(screen.getByText(/not available yet/i)).toBeTruthy();
  });

  it('is calm: no alert role, no Retry, no error wording, no reference', () => {
    const { container } = render(<NotAvailable title="Stock" />);
    expect(container.querySelector('[role="alert"], [aria-live="assertive"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry|try again/i })).toBeNull();
    expect(container.textContent).not.toMatch(/something went wrong|error|reference|request id/i);
  });

  it('draws the table header row when columns are given, in the given order', () => {
    render(<NotAvailable title="Comment codes" columns={['Code', 'Comment', 'Status']} />);
    const grid = screen.getByRole('table');
    expect(within(grid).getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim())).toEqual(['Code', 'Comment', 'Status']);
    expect(screen.getByRole('heading', { level: 1, name: 'Comment codes' })).toBeTruthy();
  });

  it('draws no table when no columns are given', () => {
    render(<NotAvailable title="Inventory" />);
    expect(screen.queryByRole('table')).toBeNull();
  });
});
