// @vitest-environment jsdom
// T0D-12 / 04-UI-UX §2.1: Button, IconButton, Menu (unit + keyboard)
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { Menu } from '../Menu/Menu';
import { DEVANAGARI, user } from './helpers';

describe('Button', () => {
  it('is a named button; default type is "button" (does not submit a form)', async () => {
    const submit = vi.fn((e: any) => e.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button>Save</Button>
      </form>,
    );
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.getAttribute('type')).toBe('button');
    await user().click(b);
    expect(submit).not.toHaveBeenCalled();
  });

  it('type="submit" submits the surrounding form', async () => {
    const submit = vi.fn((e: any) => e.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button type="submit">Save</Button>
      </form>,
    );
    await user().click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('onPress fires once for click, Enter and Space', async () => {
    const onPress = vi.fn();
    const u = user();
    render(<Button onPress={onPress}>Go</Button>);
    const b = screen.getByRole('button', { name: 'Go' });
    await u.click(b);
    expect(onPress).toHaveBeenCalledTimes(1);
    b.focus();
    await u.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledTimes(2);
    await u.keyboard(' ');
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it('isDisabled blocks presses and is exposed as disabled', async () => {
    const onPress = vi.fn();
    render(
      <Button isDisabled onPress={onPress}>
        Go
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    await user().click(b);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('isLoading: disabled, no press, accessible "Working…" label', async () => {
    const onPress = vi.fn();
    render(
      <Button isLoading onPress={onPress}>
        Save
      </Button>,
    );
    const b = screen.getByRole('button') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    await user().click(b);
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Working…') ?? screen.queryByText('Working…')).toBeTruthy();
  });

  it('shows the shortcut hint and forwards data-testid', () => {
    render(
      <Button shortcut="Ctrl+Enter" data-testid="save-btn">
        Save
      </Button>,
    );
    expect(screen.getByText('Ctrl+Enter')).toBeTruthy();
    expect(screen.getByTestId('save-btn')).toBeTruthy();
  });

  it('renders Devanagari children intact', () => {
    render(<Button>{DEVANAGARI}</Button>);
    expect(screen.getByRole('button').textContent).toContain(DEVANAGARI);
  });
});

describe('IconButton', () => {
  it('label is the accessible name; press via click/Enter/Space', async () => {
    const onPress = vi.fn();
    const u = user();
    render(<IconButton label="Close panel" icon={'close' as never} onPress={onPress} />);
    const b = screen.getByRole('button', { name: 'Close panel' });
    await u.click(b);
    b.focus();
    await u.keyboard('{Enter}');
    await u.keyboard(' ');
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it('the icon itself is hidden from assistive tech (no duplicate name)', () => {
    const { container } = render(<IconButton label="Close panel" icon={'close' as never} onPress={() => {}} />);
    for (const s of container.querySelectorAll('svg')) expect(s.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Menu', () => {
  const items = [
    { id: 'edit', label: 'Edit' },
    { id: 'archive', label: 'Archive', isDisabled: true },
    { id: 'delete', label: 'Delete', isDanger: true },
  ];
  const ui = (onAction = vi.fn()) =>
    render(<Menu trigger={<Button>Actions</Button>} items={items} onAction={onAction} />);

  it('opens from the trigger and lists items as menuitems', async () => {
    ui();
    await user().click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Edit', 'Archive', 'Delete']);
  });

  it('keyboard: Enter opens, ArrowDown + Enter fires onAction once and closes', async () => {
    const onAction = vi.fn();
    const u = user();
    ui(onAction);
    screen.getByRole('button', { name: 'Actions' }).focus();
    await u.keyboard('{Enter}');
    await u.keyboard('{ArrowDown}{Enter}');
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(['edit', 'delete']).toContain(onAction.mock.calls[0][0]);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('disabled item is aria-disabled and never fires', async () => {
    const onAction = vi.fn();
    const u = user();
    ui(onAction);
    await u.click(screen.getByRole('button', { name: 'Actions' }));
    const dis = screen.getByRole('menuitem', { name: 'Archive' });
    expect(dis.getAttribute('aria-disabled')).toBe('true');
    await u.click(dis);
    expect(onAction).not.toHaveBeenCalledWith('archive');
  });

  it('Escape closes and returns focus to the trigger (04 §5.3)', async () => {
    const u = user();
    ui();
    const t = screen.getByRole('button', { name: 'Actions' });
    await u.click(t);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(t);
  });
});
