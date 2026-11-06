// @vitest-environment jsdom
// T0D-12 / 04-UI-UX §2.6 + §5: Toast, Banner, EmptyState, ErrorState, LoadingSkeleton, PageShell, PageHeader, Tabs, layout primitives
// ASSUMED (spec names only useToast): `ToastProvider` is exported from ../Toast/Toast and must wrap callers of useToast.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from '../Toast/Toast';
import { Banner } from '../Banner/Banner';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingSkeleton } from '../LoadingSkeleton/LoadingSkeleton';
import { PageShell } from '../PageShell/PageShell';
import { PageHeader } from '../PageHeader/PageHeader';
import { Tabs } from '../Tabs/Tabs';
import { Stack } from '../Stack/Stack';
import { Inline } from '../Inline/Inline';
import { Grid } from '../Grid/Grid';
import { Card } from '../Card/Card';
import { Divider } from '../Divider/Divider';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import { DEVANAGARI, user } from './helpers';

afterEach(() => vi.useRealTimers());

function ToastBtn({ t, label = 'fire' }: { t: any; label?: string }) {
  const { show } = useToast();
  return <button onClick={() => show(t)}>{label}</button>;
}
const withToast = (t: any) =>
  render(
    <ToastProvider>
      <ToastBtn t={t} />
    </ToastProvider>,
  );

describe('Toast', () => {
  it('non-danger toast: role=status, auto-dismisses after the default 5000 ms', () => {
    vi.useFakeTimers();
    withToast({ tone: 'success', title: 'Saved', description: 'Order updated' });
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(screen.getByText('Order updated')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(4900));
    expect(screen.queryByText('Saved')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('durationMs overrides the default', () => {
    vi.useFakeTimers();
    withToast({ tone: 'info', title: 'Quick', durationMs: 1000 });
    fireEvent.click(screen.getByText('fire'));
    act(() => void vi.advanceTimersByTime(1200));
    expect(screen.queryByText('Quick')).toBeNull();
  });

  it('danger toast: role=alert and persists until dismissed', () => {
    vi.useFakeTimers();
    withToast({ tone: 'danger', title: 'Save failed' });
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByRole('alert').textContent).toContain('Save failed');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.queryByText('Save failed')).toBeTruthy();
  });

  it('title/description are text, not HTML (REQ-SEC-088)', () => {
    const { container } = withToast({ tone: 'info', title: '<img src=x onerror=alert(1)>' });
    fireEvent.click(screen.getByText('fire'));
    expect(container.ownerDocument.querySelector('img')).toBeNull();
  });
});

describe('Banner', () => {
  it('shows title, children and an action that fires', async () => {
    const onPress = vi.fn();
    render(
      <Banner tone="warning" title="Offline" action={{ label: 'Retry now', onPress }}>
        Changes will sync later.
      </Banner>,
    );
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText('Changes will sync later.')).toBeTruthy();
    await user().click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it('conveys tone with text/icon, not colour alone: has a tone marker', () => {
    const { container } = render(<Banner tone="danger" title="Failed" />);
    expect(container.querySelector('[data-tone="danger"]')).toBeTruthy();
  });
});

describe('EmptyState / ErrorState / LoadingSkeleton', () => {
  it('EmptyState: title, body, action', async () => {
    const onPress = vi.fn();
    render(<EmptyState title="No orders" body="Create one to begin." action={{ label: 'New order', onPress }} />);
    expect(screen.getByText('No orders')).toBeTruthy();
    expect(screen.getByText('Create one to begin.')).toBeTruthy();
    await user().click(screen.getByRole('button', { name: 'New order' }));
    expect(onPress).toHaveBeenCalled();
  });

  it('ErrorState: reference shown as "Reference: <id>"; retry fires; no retry button without onRetry', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState title="Could not load" requestId="0190a1b2" onRetry={onRetry} />);
    expect(screen.getByText('Reference: 0190a1b2')).toBeTruthy();
    await user().click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState title="Could not load" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Reference:/)).toBeNull();
  });

  it('ErrorState renders a hostile requestId as text', () => {
    const { container } = render(<ErrorState title="E" requestId={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it.each(['page', 'table', 'form', 'detail'] as const)('LoadingSkeleton %s is busy for assistive tech', (variant) => {
    const { container } = render(<LoadingSkeleton variant={variant} rows={3} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});

describe('PageShell / PageHeader / Tabs', () => {
  it('PageShell exposes landmarks: banner, navigation, main (+ help, banner slot)', () => {
    render(
      <PageShell topBar={<span>TOPBAR</span>} nav={<a href="#a">Orders</a>} help={<p>HELP</p>} banner={<p>BANNER</p>}>
        <h1>Content</h1>
      </PageShell>,
    );
    expect(screen.getByRole('banner').textContent).toContain('TOPBAR');
    expect(screen.getByRole('navigation').textContent).toContain('Orders');
    expect(screen.getByRole('main').textContent).toContain('Content');
    expect(screen.getByText('HELP')).toBeTruthy();
    expect(screen.getByText('BANNER')).toBeTruthy();
  });

  it('PageHeader: single h1, breadcrumb nav with current page, actions/status slots, help control', () => {
    render(
      <PageHeader
        title={DEVANAGARI}
        helpKey="orders.list"
        breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Orders', href: '/orders' }, { label: 'Detail' }]}
        actions={<button>Do it</button>}
        status={<span>STATUS</span>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(DEVANAGARI);
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(nav.querySelectorAll('a')).toHaveLength(2);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Detail');
    expect(screen.getByRole('button', { name: 'Do it' })).toBeTruthy();
    expect(screen.getByText('STATUS')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /help/i }) ?? screen.queryByRole('link', { name: /help/i })).toBeTruthy();
  });

  const items = [
    { id: 'a', label: 'Overview' },
    { id: 'b', label: 'Results', badge: '3' },
    { id: 'c', label: 'History' },
  ];
  it('Tabs: tablist, selected by id, badge text shown', () => {
    render(<Tabs items={items} selectedId="b" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /Results/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Overview/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: /Results/ }).textContent).toContain('3');
  });
  it('Tabs: click and ArrowRight call onChange with the id', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<Tabs items={items} selectedId="a" onChange={onChange} />);
    await u.click(screen.getByRole('tab', { name: /History/ }));
    expect(onChange).toHaveBeenLastCalledWith('c');
    screen.getByRole('tab', { name: /Overview/ }).focus();
    await u.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('b');
  });
});

describe('layout primitives', () => {
  it('render children and forward data-testid', () => {
    render(
      <Stack data-testid="stack">
        <Inline data-testid="inline">
          <Grid data-testid="grid">
            <Card data-testid="card">{DEVANAGARI}</Card>
          </Grid>
        </Inline>
      </Stack>,
    );
    for (const id of ['stack', 'inline', 'grid', 'card']) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId('card').textContent).toBe(DEVANAGARI);
  });
  it('Divider is a separator', () => {
    render(<Divider />);
    expect(screen.getByRole('separator')).toBeTruthy();
  });
  it('VisuallyHidden keeps text in the accessibility tree', () => {
    render(
      <button>
        <VisuallyHidden>Close dialog</VisuallyHidden>
      </button>,
    );
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeTruthy();
  });
});
