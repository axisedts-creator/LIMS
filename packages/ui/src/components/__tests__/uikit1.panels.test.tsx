// @vitest-environment jsdom
// T0D-UIKIT-1 done_when (7) SplitConsole, (8) ScanPanel, (9) SettingsForm (LD-353 templates 2, 3, 4).
// CONTRACT chosen here (writer: follow it, or file a dispute):
//   SplitConsole  components/SplitConsole/SplitConsole.tsx   props { list: ReactNode, detail: ReactNode, actions?: ReactNode, listLabel: string, detailLabel: string, 'data-testid'? }
//     DOM: div.lims-console > section.lims-console-list[aria-label=listLabel] + section.lims-console-detail[aria-label=detailLabel] > div.lims-console-body (the detail) + div.lims-console-actions (only when `actions`).
//     Queue items are any focusable element inside `list` carrying `data-console-item`. j moves focus to the next item, k to the previous (clamped at both ends).
//     When focus is not on an item (e.g. in the detail), j focuses the first item and k the last. Keys are ignored while typing (input, textarea, select, contenteditable) and with ctrl/meta/alt.
//     css: grid with the list at 40 percent and the detail at 60 percent; list and `.lims-console-body` scroll by themselves (overflow-y auto, min-height 0); actions sticky at the bottom.
//   ScanPanel     components/ScanPanel/ScanPanel.tsx     props = BarcodeInputProps & { result?: ReactNode (last scan result card), children?: ReactNode (the queue) }
//     DOM: div.lims-scan-panel > div.lims-scan-input (the BarcodeInput) , then div.lims-scan-result[role=status] (only with `result`), then div.lims-scan-queue (the children), in that order.
//     css: .lims-scan-input max-width <= 28rem, with a LIGHT focus ring on the input (a rule for `.lims-scan-input ... :focus` that sets outline or box-shadow from tokens, no 3px+ ring).
//   SettingsForm  components/SettingsForm/SettingsForm.tsx   props { tabs?: ReactNode, children: ReactNode (fields), onSave: () => void, saveLabel?: string (default "Save"), isSaving?: boolean, 'data-testid'? }
//     DOM: div.lims-settings > div.lims-settings-tabs (only with `tabs`) + form.lims-settings-form > div.lims-settings-fields (children) + div.lims-settings-bar (the Save button, type submit, last in the form).
//     css: form max-width <= 32rem; two columns for the fields only from @media (min-width: 64rem); switches start aligned; the bar is position sticky at the bottom.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScanPanel } from '../ScanPanel/ScanPanel';
import { SettingsForm } from '../SettingsForm/SettingsForm';
import { SplitConsole } from '../SplitConsole/SplitConsole';
import { Switch } from '../Switch/Switch';
import { TextField } from '../TextField/TextField';
import { declared, rem, rulesMatching } from './uikit1-css';
import { user } from './helpers';

// ───────────────────────────── SplitConsole ─────────────────────────────
const queue = (n: number) => (
  <>
    <input aria-label="Filter queue" />
    <ul>
      {Array.from({ length: n }, (_, i) => (
        <li key={i}><button type="button" data-console-item data-testid={`q${i}`}>{`Sample ${i}`}</button></li>
      ))}
    </ul>
  </>
);
function consoleView(extra: Partial<React.ComponentProps<typeof SplitConsole>> = {}) {
  return render(
    <SplitConsole listLabel="Verification queue" detailLabel="Sample detail" list={queue(3)} detail={<div><textarea aria-label="Comment" /><p>Results</p></div>} {...extra} />,
  );
}

describe('SplitConsole: structure', () => {
  it('queue list left, detail right, each a labelled region', () => {
    const { container } = consoleView();
    const list = screen.getByRole('region', { name: 'Verification queue' });
    const detail = screen.getByRole('region', { name: 'Sample detail' });
    expect(list.classList.contains('lims-console-list')).toBe(true);
    expect(detail.classList.contains('lims-console-detail')).toBe(true);
    expect(list.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.lims-console')!.children).toHaveLength(2);
  });
  it('the detail has a separate scrolling body and, only with `actions`, a sticky action bar after it', () => {
    const a = consoleView();
    expect(a.container.querySelector('.lims-console-detail > .lims-console-body')).toBeTruthy();
    expect(a.container.querySelector('.lims-console-actions')).toBeNull();
    a.unmount();
    const b = consoleView({ actions: <button type="button">Approve</button> });
    const detail = b.container.querySelector('.lims-console-detail')!;
    expect(detail.lastElementChild!.classList.contains('lims-console-actions')).toBe(true);
    expect(within(detail.lastElementChild as HTMLElement).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(detail.querySelector('.lims-console-body')!.contains(detail.querySelector('.lims-console-actions'))).toBe(false);
  });
  it('css: 40 / 60 split, list and body scroll separately, actions sticky at the bottom, min-width 0', () => {
    const cols = (declared(/^\.lims-console$/, 'grid-template-columns') ?? '').replace(/minmax\(\s*0(rem)?\s*,\s*([^)]+)\)/g, '$2');
    expect(declared(/^\.lims-console$/, 'display')).toBe('grid');
    const parts = cols.split(/\s+/).map((p) => parseFloat(p));
    expect(parts, cols).toHaveLength(2);
    expect(parts[0]! / (parts[0]! + parts[1]!)).toBeCloseTo(0.4, 5);
    for (const sel of [/^\.lims-console-list$/, /^\.lims-console-body$/]) {
      expect(declared(sel, 'overflow-y') ?? declared(sel, 'overflow')).toBe('auto');
      expect(declared(sel, 'min-height')).toMatch(/^0(rem)?$/);
    }
    expect(declared(/^\.lims-console-actions$/, 'position')).toBe('sticky');
    expect(declared(/^\.lims-console-actions$/, 'bottom')).toMatch(/^0(rem)?$/);
  });
});

describe('SplitConsole: j and k move focus through the queue', () => {
  it('j goes down, k goes up, both stop at the ends', async () => {
    consoleView();
    const u = user();
    screen.getByTestId('q0').focus();
    await u.keyboard('j');
    expect(document.activeElement).toBe(screen.getByTestId('q1'));
    await u.keyboard('j');
    expect(document.activeElement).toBe(screen.getByTestId('q2'));
    await u.keyboard('j');
    expect(document.activeElement).toBe(screen.getByTestId('q2'));
    await u.keyboard('k');
    expect(document.activeElement).toBe(screen.getByTestId('q1'));
    await u.keyboard('kk');
    expect(document.activeElement).toBe(screen.getByTestId('q0'));
  });
  it('from the detail, j focuses the first item and k the last', async () => {
    consoleView({ detail: <button type="button" data-testid="d">Detail button</button> });
    const u = user();
    screen.getByTestId('d').focus();
    await u.keyboard('j');
    expect(document.activeElement).toBe(screen.getByTestId('q0'));
    screen.getByTestId('d').focus();
    await u.keyboard('k');
    expect(document.activeElement).toBe(screen.getByTestId('q2'));
  });
  it('typing j or k in the queue filter or in the comment box does not move focus (no hijacked typing)', async () => {
    consoleView();
    const u = user();
    const filter = screen.getByLabelText('Filter queue') as HTMLInputElement;
    await u.click(filter);
    await u.keyboard('jk');
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe('jk');
    const comment = screen.getByLabelText('Comment') as HTMLTextAreaElement;
    await u.click(comment);
    await u.keyboard('kj');
    expect(document.activeElement).toBe(comment);
    expect(comment.value).toBe('kj');
  });
  it('ctrl, meta and alt with j or k are left to the browser', () => {
    consoleView();
    screen.getByTestId('q0').focus();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) fireEvent.keyDown(screen.getByTestId('q0'), { key: 'j', ...mod });
    expect(document.activeElement).toBe(screen.getByTestId('q0'));
  });
  it('an empty queue: j and k do nothing and do not throw', async () => {
    consoleView({ list: <p>No samples waiting</p> });
    await user().keyboard('jk');
    expect(screen.getByText('No samples waiting')).toBeTruthy();
  });
  it('the queue label and detail label are text, never markup', () => {
    const { container } = consoleView({ listLabel: '<img src=x onerror=alert(1)>' });
    expect(container.querySelector('img')).toBeNull();
  });
});

// ───────────────────────────── ScanPanel ─────────────────────────────
describe('ScanPanel', () => {
  const base = { label: 'Scan tube barcode', name: 'scan', autoFocus: false };
  it('order: scan input, then the last result card, then the queue', () => {
    const { container } = render(
      <ScanPanel {...base} onScan={() => {}} result={<p>Tube ABC1234 received</p>}>
        <table aria-label="Queue"><tbody><tr><td>Row</td></tr></tbody></table>
      </ScanPanel>,
    );
    const panel = container.querySelector('.lims-scan-panel')!;
    expect([...panel.children].map((c) => c.className.split(' ')[0])).toEqual(['lims-scan-input', 'lims-scan-result', 'lims-scan-queue']);
    expect(panel.querySelector('.lims-scan-input input')).toBeTruthy();
    const result = panel.querySelector('.lims-scan-result') as HTMLElement;
    expect(result.getAttribute('role')).toBe('status');
    expect(result.textContent).toBe('Tube ABC1234 received');
    expect(within(panel.querySelector('.lims-scan-queue') as HTMLElement).getByRole('table', { name: 'Queue' })).toBeTruthy();
  });
  it('no result yet: no empty result card (no gap); no children: no empty queue box', () => {
    const { container } = render(<ScanPanel {...base} onScan={() => {}} />);
    expect(container.querySelector('.lims-scan-result')).toBeNull();
    expect(container.querySelector('.lims-scan-queue')).toBeNull();
  });
  it('scanning works exactly as BarcodeInput: typed value + Enter calls onScan with the value', async () => {
    const onScan = vi.fn();
    render(<ScanPanel {...base} onScan={onScan} />);
    await user().type(screen.getByLabelText('Scan tube barcode'), 'ABC1234{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('ABC1234');
  });
  it('a value outside the barcode charset is refused by the kit input and never reaches onScan', async () => {
    const onScan = vi.fn();
    render(<ScanPanel {...base} onScan={onScan} />);
    await user().type(screen.getByLabelText('Scan tube barcode'), '<script>{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });
  it('a hostile result slot is only what the caller passed (text stays text)', () => {
    const { container } = render(<ScanPanel {...base} onScan={() => {}} result={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
  });
  it('css: scan input at most 28rem wide', () => {
    const w = declared(/^\.lims-scan-input$/, 'max-width');
    expect(rem(w), `max-width was ${w}`).toBeLessThanOrEqual(28);
    expect(rem(w)).toBeGreaterThan(0);
  });
  it('css: a light focus ring on the scan input: tokens only, no 3px+ ring or glow', () => {
    const focus = rulesMatching(/lims-scan-input.*:(focus|focus-visible|focus-within)/);
    expect(focus.length).toBeGreaterThan(0);
    const text = focus.flatMap((r) => [...r.decls].map(([k, v]) => `${k}: ${v}`)).join('; ');
    expect(text).toMatch(/outline|box-shadow/);
    expect(text).toMatch(/var\(--lims-/);
    expect(text).not.toMatch(/\b([3-9]|\d\d)px/);
  });
  it('css: the result card and the queue shrink (min-width 0) so a long barcode or wide queue never scrolls the page', () => {
    expect(declared(/^\.lims-scan-panel$/, 'min-width')).toMatch(/^0(rem)?$/);
  });
});

// ───────────────────────────── SettingsForm ─────────────────────────────
describe('SettingsForm', () => {
  it('tabs slot above one form; fields in .lims-settings-fields; Save bar last, a submit button', async () => {
    const onSave = vi.fn();
    const { container } = render(
      <SettingsForm tabs={<nav aria-label="Settings sections"><a href="#general">General</a></nav>} onSave={onSave}>
        <TextField label="Lab name" name="lab" />
        <Switch label="Print on approval" />
      </SettingsForm>,
    );
    const root = container.querySelector('.lims-settings')!;
    expect(root.firstElementChild!.classList.contains('lims-settings-tabs')).toBe(true);
    expect(within(root.querySelector('.lims-settings-tabs') as HTMLElement).getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    const form = root.querySelector('form.lims-settings-form') as HTMLFormElement;
    expect(form.querySelector('.lims-settings-fields')!.textContent).toMatch(/Lab name/);
    expect(form.lastElementChild!.classList.contains('lims-settings-bar')).toBe(true);
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(save.getAttribute('type')).toBe('submit');
    expect(form.lastElementChild!.contains(save)).toBe(true);
    await user().click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it('Enter in a text field submits (onSave once) and the page does not reload (default prevented)', async () => {
    const onSave = vi.fn();
    render(<SettingsForm onSave={onSave}><TextField label="Lab name" name="lab" /></SettingsForm>);
    const submit = vi.fn((e: Event) => e.defaultPrevented);
    document.addEventListener('submit', submit);
    await user().type(screen.getByLabelText('Lab name'), 'Metro{Enter}');
    document.removeEventListener('submit', submit);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(submit.mock.results[0]?.value).toBe(true);
  });
  it('no tabs: no empty tabs strip; saveLabel renames the button', () => {
    const { container } = render(<SettingsForm saveLabel="Save changes" onSave={() => {}}><TextField label="A" name="a" /></SettingsForm>);
    expect(container.querySelector('.lims-settings-tabs')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });
  it('isSaving disables Save so a double click cannot save twice', async () => {
    const onSave = vi.fn();
    render(<SettingsForm isSaving onSave={onSave}><TextField label="A" name="a" /></SettingsForm>);
    const btn = screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute('aria-disabled') === 'true').toBe(true);
    await user().click(btn);
    expect(onSave).not.toHaveBeenCalled();
  });
  it('css: form at most 32rem, two columns only from 64rem, switches start aligned, Save bar sticky at the bottom', () => {
    const w = declared(/^\.lims-settings-form$/, 'max-width');
    expect(rem(w), `max-width was ${w}`).toBeLessThanOrEqual(32);
    expect(rem(w)).toBeGreaterThan(0);
    expect(declared(/^\.lims-settings-fields$/, 'grid-template-columns') ?? '1fr').not.toMatch(/repeat\(\s*2|1fr\s+1fr/);
    const two = rulesMatching(/^\.lims-settings-fields$/, '(min-width: 64rem)');
    expect(two.some((r) => /repeat\(\s*2|1fr\s+1fr/.test(r.decls.get('grid-template-columns') ?? ''))).toBe(true);
    const sw = rulesMatching(/lims-settings.*\.lims-switch|lims-switch.*lims-settings/);
    expect(sw.some((r) => /^(start|flex-start|left)$/.test(r.decls.get('justify-self') ?? r.decls.get('justify-content') ?? r.decls.get('justify-items') ?? ''))).toBe(true);
    expect(declared(/^\.lims-settings-bar$/, 'position')).toBe('sticky');
    expect(declared(/^\.lims-settings-bar$/, 'bottom')).toMatch(/^0(rem)?$/);
  });
});
