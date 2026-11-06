// @vitest-environment jsdom
// T0D-12 review item 1 / 04-UI-UX:233 + §5.3: Tooltip, Popover, Spinner, Badge.
// ASSUMED API (spec silent; writer must match or raise CR):
//   <Tooltip content="..">{focusable child}</Tooltip>      (react-aria TooltipTrigger/Tooltip; role=tooltip)
//   <Popover trigger={<button>..</button>} title="..">{children}</Popover>   (react-aria DialogTrigger/Popover; role=dialog named by title)
//   <Spinner />  -> role=status, accessible text from msg.loading; <Spinner label="x" /> overrides
//   <Badge tone="..">text</Badge> -> data-tone="<tone>", text visible (never colour-only, 04 §1.3)
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Tooltip } from '../Tooltip/Tooltip';
import { Popover } from '../Popover/Popover';
import { Spinner } from '../Spinner/Spinner';
import { Badge } from '../Badge/Badge';
import { msg } from '../_shared/messages';
import { user } from './helpers';

describe('Tooltip (keyboard)', () => {
  it('opens on keyboard focus, is described by the tooltip text, closes on Escape', async () => {
    const u = user();
    render(
      <Tooltip content="Print label">
        <button>Print</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    await u.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Print label'));
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Print' })); // Esc must not move focus
  });
});

describe('Popover (keyboard)', () => {
  const ui = (
    <Popover trigger={<button>Details</button>} title="Specimen details">
      <button>Inside A</button>
      <button>Inside B</button>
    </Popover>
  );

  it('opens from keyboard (Enter), role=dialog named by title', async () => {
    const u = user();
    render(ui);
    await u.tab();
    await u.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Specimen details' })).toBeTruthy();
  });

  it('Tab stays trapped inside the popover; Escape closes and returns focus to the trigger', async () => {
    const u = user();
    render(ui);
    const trigger = screen.getByRole('button', { name: 'Details' });
    await u.tab();
    await u.keyboard('{Enter}');
    const dlg = await screen.findByRole('dialog', { name: 'Specimen details' });
    for (let i = 0; i < 6; i++) {
      await u.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Spinner', () => {
  it('is a status region with an accessible default label from msg.loading', () => {
    render(<Spinner />);
    const s = screen.getByRole('status');
    expect(s.textContent).toContain(msg.loading);
  });

  it('custom label replaces the default', () => {
    render(<Spinner label="Saving result" />);
    expect(screen.getByRole('status').textContent).toContain('Saving result');
  });
});

describe('Badge', () => {
  it.each(['neutral', 'info', 'success', 'warning', 'danger'])('tone %s is exposed and text stays visible', (tone) => {
    const { container } = render(<Badge tone={tone as any}>12</Badge>);
    expect(container.textContent).toBe('12');
    expect(container.querySelector(`[data-tone="${tone}"]`)).toBeTruthy();
  });

  it('renders markup in children as text, not HTML (REQ-SEC-088)', () => {
    const { container } = render(<Badge tone="neutral">{'<img src=x onerror=alert(1)>'}</Badge>);
    expect(container.querySelector('img')).toBeNull();
  });
});
