// @vitest-environment jsdom
// T0D-UIKIT-1 (LD-353 rules 6 and 8; done_when 4): EmptyState, ErrorState and NotAvailable have one look and keep a title.
// CONTRACT chosen here (writer: follow it, or file a dispute):
//   * kit gets NotAvailable at components/NotAvailable/NotAvailable.tsx, same props as the web one it replaces: { title, columns?, helpKey?, body? }.
//     `title` is the PAGE title (h1 via PageHeader); the state's own title stays "Not available yet". apps/web/src/core/shell/NotAvailable.tsx re-exports it.
//   * ErrorState gets an optional `pageTitle`: when given, the h1 page title is rendered above the state and is kept (LD-353 rule 6). `title` stays the state title.
//   * all three render the same root `div.lims-state` with `p.lims-state-title`, optional `p.lims-state-body`; no other wrapper, so spacing is shared.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { NotAvailable } from '../NotAvailable/NotAvailable';
import { rulesMatching } from './uikit1-css';
import { user } from './helpers';

const stateRoot = (c: HTMLElement) => c.querySelector('.lims-state') as HTMLElement;

describe('one look: same root, same title and body elements, same spacing', () => {
  it('all three render a div.lims-state holding p.lims-state-title (and p.lims-state-body when a body is given)', () => {
    const a = render(<EmptyState title="No samples" body="Samples appear here." />).container;
    const b = render(<ErrorState title="Could not load" body="Try again." requestId="abcd1234" onRetry={() => {}} />).container;
    const c = render(<NotAvailable title="Lab pending" />).container;
    for (const root of [stateRoot(a), stateRoot(b), stateRoot(c)]) {
      expect(root, 'no .lims-state root').toBeTruthy();
      expect(root.tagName).toBe('DIV');
      expect(root.querySelector(':scope > p.lims-state-title')).toBeTruthy();
      expect(root.querySelector(':scope > p.lims-state-body')).toBeTruthy();
    }
  });

  it('the state title is the first text of every state and is a paragraph, never a heading (the page h1 is separate)', () => {
    const { container } = render(<><EmptyState title="E" /><ErrorState title="F" /><NotAvailable title="G" /></>);
    for (const el of container.querySelectorAll('.lims-state-title')) expect(el.tagName).toBe('P');
    // only NotAvailable brings a page h1 (its title); EmptyState and a bare ErrorState add none
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('EmptyState: a title, one hint line and at most one button (rule 6)', () => {
    const { container } = render(<EmptyState title="No samples" body="Samples appear here." action={{ label: 'New sample', onPress: () => {} }} />);
    expect(container.querySelectorAll('.lims-state-title')).toHaveLength(1);
    expect(container.querySelectorAll('.lims-state-body')).toHaveLength(1);
    expect(container.querySelectorAll('button, a')).toHaveLength(1);
  });

  it('kit.css gives no state variant its own padding, gap or margin (outside the data-density override that already exists)', () => {
    const variants = rulesMatching(/\.lims-state(?![-\w])/).filter((r) => r.sels.every((s) => !s.startsWith("[data-density")));
    for (const r of variants) {
      for (const p of ['padding', 'padding-block', 'padding-inline', 'gap', 'margin', 'row-gap']) {
        if (!r.decls.has(p)) continue;
        // the one base rule `.lims-state { ... }` may declare them; a rule that also names a tone, a state kind or a page class may not
        expect(r.sels.every((s) => s === '.lims-state'), `variant rule ${r.sels.join(', ')} sets ${p}`).toBe(true);
      }
    }
  });
});

describe('ErrorState keeps its title; page title kept with pageTitle', () => {
  it('shows title, reference and Retry; Retry calls onRetry', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Could not load reports" requestId="req-12345" onRetry={onRetry} />);
    expect(screen.getByText('Could not load reports')).toBeTruthy();
    expect(screen.getByText(/Reference: req-12345/)).toBeTruthy();
    await user().click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('pageTitle renders the h1 above the state, and the h1 text equals the given page title', () => {
    const { container } = render(<ErrorState pageTitle="Reporting" title="Could not load" requestId="r1" onRetry={() => {}} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Reporting');
    expect(h1.compareDocumentPosition(stateRoot(container)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Could not load')).toBeTruthy();
  });

  it('without pageTitle nothing changes: no h1 (existing callers stay compatible)', () => {
    render(<ErrorState title="Could not load" />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});

describe('NotAvailable (moved to the kit)', () => {
  it('keeps the page title as the h1, says "Not available yet", and is calm: no alert, Retry or reference', () => {
    render(<NotAvailable title="Lab pending" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Lab pending');
    expect(screen.getByText('Not available yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/Reference:/)).toBeNull();
  });

  it('columns render a full header row above the state, one th per column, in order', () => {
    render(<NotAvailable title="Lab pending" columns={['Sample', 'Patient', 'Received']} />);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Sample', 'Patient', 'Received']);
    expect(within(screen.getByRole('table')).getByText('Not available yet')).toBeTruthy();
  });

  it('body overrides the hint line (additive prop)', () => {
    render(<NotAvailable title="Lab pending" body="Switched on in the next release." />);
    expect(screen.getByText('Switched on in the next release.')).toBeTruthy();
  });

  it('a hostile title is text, not markup', () => {
    const { container } = render(<NotAvailable title={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
