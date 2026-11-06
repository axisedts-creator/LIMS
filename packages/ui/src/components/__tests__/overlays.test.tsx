// @vitest-environment jsdom
// T0D-12 / 04-UI-UX §2.6 + §5.3: Dialog, ConfirmDialog, Drawer (focus trap, Esc, focus return)
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dialog } from '../Dialog/Dialog';
import { ConfirmDialog } from '../ConfirmDialog/ConfirmDialog';
import { Drawer } from '../Drawer/Drawer';
import { user } from './helpers';

function Host({ Comp, ...rest }: any) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Comp title="Reject specimen" isOpen={open} onClose={() => setOpen(false)} {...rest}>
        <input aria-label="Reason note" />
      </Comp>
    </>
  );
}

describe.each([
  ['Dialog', Dialog],
  ['Drawer', Drawer],
])('%s', (_n, Comp) => {
  it('renders nothing when closed; role=dialog named by title when open', async () => {
    render(<Host Comp={Comp} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user().click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog', { name: 'Reject specimen' })).toBeTruthy();
  });

  it('Escape closes and focus returns to the opener (04 §5.3)', async () => {
    const u = user();
    render(<Host Comp={Comp} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await u.click(opener);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('focus is trapped: Tab never leaves the dialog', async () => {
    const u = user();
    render(<Host Comp={Comp} />);
    await u.click(screen.getByRole('button', { name: 'Open' }));
    const dlg = screen.getByRole('dialog');
    for (let i = 0; i < 6; i++) {
      await u.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      await u.tab({ shift: true });
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it('forwards data-testid', () => {
    render(<Comp title="T" isOpen onClose={() => {}} data-testid="ov">x</Comp>);
    expect(screen.getByTestId('ov')).toBeTruthy();
  });
});

describe('Dialog specifics', () => {
  it('Escape calls onClose when dismissable (default)', async () => {
    const onClose = vi.fn();
    render(<Dialog title="T" isOpen onClose={onClose}>body</Dialog>);
    await user().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('isDismissable={false}: Escape does not close', async () => {
    const onClose = vi.fn();
    render(<Dialog title="T" isOpen isDismissable={false} onClose={onClose}>body</Dialog>);
    await user().keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('renders the footer slot', () => {
    render(<Dialog title="T" isOpen onClose={() => {}} footer={<button>Done</button>}>body</Dialog>);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});

describe('ConfirmDialog', () => {
  const reasons = [
    { code: 'wrong_tube', display: 'Wrong tube' },
    { code: 'hemolyzed', display: 'Hemolyzed' },
  ];
  const base = { title: 'Reject specimen', body: 'This cannot be undone.', confirmLabel: 'Reject', isOpen: true };

  it('plain confirm: Confirm calls onConfirm; Cancel calls onCancel', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const u = user();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('dialog', { name: 'Reject specimen' })).toBeTruthy();
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await u.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('requireReason: cannot confirm without a reason; passes reasonCode when chosen', async () => {
    const onConfirm = vi.fn();
    const u = user();
    render(<ConfirmDialog {...base} requireReason={{ codedSet: 'reject_reason', options: reasons }} onConfirm={onConfirm} onCancel={() => {}} />);
    await u.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await u.click(screen.getByRole('button', { name: /reason/i }));
    await u.click(screen.getByRole('option', { name: 'Wrong tube' }));
    await u.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ reasonCode: 'wrong_tube' });
  });

  it('required free text blocks confirm until filled; maxLength enforced; reasonText passed', async () => {
    const onConfirm = vi.fn();
    const u = user();
    render(
      <ConfirmDialog
        {...base}
        requireReason={{ codedSet: 'reject_reason', options: reasons, freeText: { maxLength: 5, isRequired: true } }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await u.click(screen.getByRole('button', { name: /reason/i }));
    await u.click(screen.getByRole('option', { name: 'Hemolyzed' }));
    await u.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).not.toHaveBeenCalled();
    const t = screen.getByRole('textbox') as HTMLInputElement;
    expect(t.maxLength).toBe(5);
    await u.type(t, 'abcdefgh');
    expect(t.value).toBe('abcde');
    await u.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ reasonCode: 'hemolyzed', reasonText: 'abcde' });
  });

  it('double-click while onConfirm is pending fires once (no double reject)', async () => {
    let release!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (release = r)));
    const u = user();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={() => {}} />);
    const b = screen.getByRole('button', { name: /Reject/ });
    await u.click(b);
    await u.click(b);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
  });

  it('danger tone still exposes a named confirm button', () => {
    render(<ConfirmDialog {...base} tone="danger" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});
