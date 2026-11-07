// @vitest-environment jsdom
// T0D-12b (04-UI-UX §2.8, Phase-1 set): CodeField, FormulaEditor, OtpInput, RichTextEditor (+SafeHtml), KeyValueListEditor, PeriodPicker.
// ASSUMED API (spec gives behaviour, not prop names; writer must match or raise CR). All fields take FieldBase (label, name, description?, error?, isRequired?, isDisabled?, isReadOnly?).
//   CodeField        { value, onChange(v), maxLength, pattern: string (regex source), patternHint: string }  upper-cases input, hint linked by aria-describedby
//   FormulaEditor    { value, onChange(v), maxLength, diagnostics?: {message:string; position:number}[] }       monospace textarea, diagnostics shown as text
//   OtpInput         { label, length: 6, value?, onChange?(v), onComplete?(v), error?, isDisabled? }  (C6 04-UI-UX:322)   cells or one field, digits only; Enter and filling all 6 call onComplete
//   RichTextEditor   { value?: string(html), onChange?(html), maxLength (TEXT-content chars), allowed: ('bold'|'italic'|'underline'|'bullet_list'|'ordered_list'|'table'|'h3'|'h4')[] }  (C6 04-UI-UX:319-320)
//                    + named export SafeHtml({ html }) with the same allowlist (p, br, strong, em, u, ul, ol, li, a[href], h3, h4, table); toolbar shows only the `allowed` tools
//   KeyValueListEditor { value: {key,value}[], onChange, maxRows, keyMaxLength, valueMaxLength }              buttons "Add" / "Remove"
//   PeriodPicker     { value: {preset, from?, to?}, presets: PresetId[] (only these are listed), onChange, calendar: 'AD'|'BS' }  (C8 02-TRD:1093) preset ids: today, yesterday, this_bs_month, last_bs_month,
//                    this_fy, last_fy, this_ad_month, last_ad_month, custom; custom range <= 366 days (C8 04-UI-UX:44)
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { CodeField } from '../CodeField/CodeField';
import { FormulaEditor } from '../FormulaEditor/FormulaEditor';
import { OtpInput } from '../OtpInput/OtpInput';
import { RichTextEditor, SafeHtml } from '../RichTextEditor/RichTextEditor';
import { KeyValueListEditor } from '../KeyValueListEditor/KeyValueListEditor';
import { PeriodPicker } from '../PeriodPicker/PeriodPicker';
import { DEVANAGARI, XSS, seriousViolations, user } from './helpers';

describe('CodeField (C3)', () => {
  const Harness = ({ onChange = () => {} }: { onChange?: (v: string) => void }) => {
    const [v, setV] = useState('');
    return (
      <CodeField label="Code" name="code" value={v} onChange={(x: string) => { setV(x); onChange(x); }} maxLength={32}
        pattern="^[A-Z0-9][A-Z0-9_]{0,31}$" patternHint="Letters, digits and underscore; starts with a letter or digit" />
    );
  };
  it('upper-cases what the user types and reports the upper-cased value', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user().type(screen.getByRole('textbox', { name: /code/i }), 'cbc_01');
    expect(onChange).toHaveBeenLastCalledWith('CBC_01');
    expect((screen.getByRole('textbox', { name: /code/i }) as HTMLInputElement).value).toBe('CBC_01');
  });
  it('mirrors maxLength on the input and shows the regex hint linked by aria-describedby', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: /code/i });
    expect(input.getAttribute('maxlength')).toBe('32');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.map((i) => document.getElementById(i)?.textContent).join(' ')).toMatch(/starts with a letter or digit/);
  });
  it('read-only (code is create-only) cannot be edited', async () => {
    const onChange = vi.fn();
    render(<CodeField label="Code" name="code" value="CBC" onChange={onChange} maxLength={32} pattern="^[A-Z]+$" patternHint="h" isReadOnly />);
    await user().type(screen.getByRole('textbox', { name: /code/i }), 'x');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('error is text linked to the input and sets aria-invalid', () => {
    render(<CodeField label="Code" name="code" value="" onChange={() => {}} maxLength={32} pattern="^[A-Z]+$" patternHint="h" error="Code already exists" />);
    const input = screen.getByRole('textbox', { name: /code/i });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Code already exists')).toBeTruthy();
  });
  it('axe clean', async () => {
    render(<Harness />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('FormulaEditor (C3)', () => {
  it('is a labelled monospace multi-line control that reports edits and Devanagari-safe text', async () => {
    const onChange = vi.fn();
    render(<FormulaEditor label="Formula" name="formula" value="" onChange={onChange} maxLength={500} />);
    const box = screen.getByRole('textbox', { name: /formula/i });
    expect(box.getAttribute('maxlength')).toBe('500');
    await user().type(box, 'MCV / RBC');
    expect(onChange).toHaveBeenLastCalledWith('MCV / RBC');
  });
  it('renders diagnostics as text with their position, linked to the control (not colour only)', () => {
    render(<FormulaEditor label="Formula" name="formula" value="MCV /" onChange={() => {}} maxLength={500}
      diagnostics={[{ message: 'Unexpected end of formula', position: 5 }]} />);
    const box = screen.getByRole('textbox', { name: /formula/i });
    const text = (box.getAttribute('aria-describedby') ?? '').split(' ').map((i) => document.getElementById(i)?.textContent ?? '').join(' ');
    expect(text).toContain('Unexpected end of formula');
    expect(text).toContain('5');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });
  it('diagnostic messages are text nodes (XSS)', () => {
    (window as any).__xss = 0;
    const { container } = render(<FormulaEditor label="Formula" name="formula" value="" onChange={() => {}} maxLength={500}
      diagnostics={XSS.map((m, i) => ({ message: m, position: i }))} />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect(screen.getAllByText(XSS[0]).length).toBeGreaterThan(0);
    expect((window as any).__xss).toBe(0);
  });
  it('accepts Devanagari input without mangling', async () => {
    const onChange = vi.fn();
    render(<FormulaEditor label="Formula" name="formula" value={DEVANAGARI} onChange={onChange} maxLength={500} />);
    expect((screen.getByRole('textbox', { name: /formula/i }) as HTMLTextAreaElement).value).toBe(DEVANAGARI);
  });
  it('axe clean', async () => {
    render(<FormulaEditor label="Formula" name="formula" value="A+B" onChange={() => {}} maxLength={500} diagnostics={[{ message: 'Unknown analyte B', position: 2 }]} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('OtpInput (C2 + C6)', () => {
  const inputs = () => screen.getAllByRole('textbox') as HTMLInputElement[];
  it('is a group named by its label; every input is numeric and one carries autocomplete=one-time-code', () => {
    render(<OtpInput label="6-digit code" length={6} onChange={() => {}} onComplete={() => {}} />);
    expect(screen.queryByRole('group', { name: /6-digit code/i }) ?? screen.queryByRole('textbox', { name: /6-digit code/i })).toBeTruthy();
    for (const i of inputs()) expect(i.getAttribute('inputmode')).toBe('numeric');
    expect(inputs().some((i) => i.getAttribute('autocomplete') === 'one-time-code')).toBe(true);
  });
  it('paste of 6 digits fills everything and reports them', async () => {
    const onChange = vi.fn();
    render(<OtpInput label="6-digit code" length={6} onChange={onChange} onComplete={() => {}} />);
    const u = user();
    await u.click(inputs()[0]);
    await u.paste('123456');
    expect(onChange).toHaveBeenLastCalledWith('123456');
    expect(inputs().map((i) => i.value).join('')).toBe('123456');
  });
  it('typing digits works; letters and symbols are rejected; the reported value is digits only', async () => {
    const onChange = vi.fn();
    render(<OtpInput label="6-digit code" length={6} onChange={onChange} onComplete={() => {}} />);
    const u = user();
    await u.click(inputs()[0]);
    await u.keyboard('1a2-b3');
    for (const c of onChange.mock.calls) expect(c[0]).toMatch(/^[0-9]{0,6}$/);
    expect(onChange).toHaveBeenLastCalledWith('123');
  });
  it('pasting garbage or an over-long string never yields more than 6 or any non-digit', async () => {
    const onChange = vi.fn();
    const onComplete = vi.fn();
    render(<OtpInput label="6-digit code" length={6} onChange={onChange} onComplete={onComplete} />);
    const u = user();
    await u.click(inputs()[0]);
    await u.paste('<script>alert(1)</script>');
    await u.paste('12345678901234567890');
    for (const c of onChange.mock.calls) expect(c[0]).toMatch(/^[0-9]{0,6}$/);
    for (const c of onComplete.mock.calls) expect(c[0]).toMatch(/^[0-9]{6}$/);
  });
  it('onComplete: not called for a partial code (typing or Enter); called with the 6 digits once complete', async () => {
    const onComplete = vi.fn();
    render(<OtpInput label="6-digit code" length={6} onChange={() => {}} onComplete={onComplete} />);
    const u = user();
    await u.click(inputs()[0]);
    await u.keyboard('123{Enter}');
    expect(onComplete).not.toHaveBeenCalled();
    await u.keyboard('456');
    expect(onComplete).toHaveBeenCalledWith('123456'); // complete-fill calls onComplete (C0 §2.8)
  });
  it('Enter on a complete code calls onComplete(code)', async () => {
    const onComplete = vi.fn();
    render(<OtpInput label="6-digit code" length={6} onChange={() => {}} onComplete={onComplete} />);
    const u = user();
    await u.click(inputs()[0]);
    await u.paste('654321');
    onComplete.mockClear();
    await u.keyboard('{Enter}');
    expect(onComplete).toHaveBeenCalledWith('654321');
  });
  it('props are optional: renders with only label+length; isDisabled disables every input; value prop is shown', () => {
    const { unmount } = render(<OtpInput label="6-digit code" length={6} value="123" />);
    expect(inputs().map((i) => i.value).join('')).toBe('123');
    unmount();
    render(<OtpInput label="6-digit code" length={6} isDisabled />);
    for (const i of inputs()) expect(i.disabled).toBe(true);
  });
  it('error is text; axe clean', async () => {
    render(<OtpInput label="6-digit code" length={6} onChange={() => {}} onComplete={() => {}} error="That code is not right. You have 4 tries left." />);
    expect(screen.getByText(/You have 4 tries left/)).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
  });
});

const ALL_TOOLS = ['bold', 'italic', 'underline', 'bullet_list', 'ordered_list', 'table', 'h3', 'h4'] as const;

describe('RichTextEditor + SafeHtml (C6, REQ-SEC-088)', () => {
  const evil =
    '<p>ok <strong>bold</strong> <em>it</em></p><script>window.__xss=1</script><img src=x onerror="window.__xss=2"><a href="javascript:alert(1)" onclick="window.__xss=3">x</a>' +
    '<iframe src="https://evil.example"></iframe><svg onload="window.__xss=4"></svg><p style="position:fixed">s</p><ul><li>one</li></ul>';
  it('SafeHtml keeps allowlisted marks and drops script/img/iframe/svg/style/on*/javascript:', () => {
    (window as any).__xss = 0;
    const { container } = render(<SafeHtml html={evil} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')).toBeTruthy();
    expect(container.querySelector('li')?.textContent).toBe('one');
    expect(container.querySelector('script, img, iframe, svg, object, embed, style')).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onclick|onload|javascript:|style=/i);
    expect((window as any).__xss).toBe(0);
  });
  it('SafeHtml: surviving links are http(s)/relative only and carry rel=noopener noreferrer', () => {
    const { container } = render(<SafeHtml html={'<a href="https://example.org/x">ok</a><a href="data:text/html,<b>">d</a><a href="vbscript:x">v</a>'} />);
    for (const a of Array.from(container.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? '').toMatch(/^(https?:|\/|#)/);
      expect(a.getAttribute('rel') ?? '').toMatch(/noopener/);
    }
  });
  it('SafeHtml renders plain text nodes for unknown tags rather than executing them', () => {
    const { container } = render(<SafeHtml html={'<marquee onstart="window.__xss=5">scroll</marquee>'} />);
    expect(container.querySelector('marquee')).toBeNull();
    expect(container.textContent).toContain('scroll');
  });
  it('editor: labelled, has a toolbar with named toggle buttons, and sanitises hostile initial value', () => {
    (window as any).__xss = 0;
    const { container } = render(<RichTextEditor label="Findings" name="findings" value={evil} onChange={() => {}} maxLength={20000} allowed={ALL_TOOLS} />);
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(within(screen.getByRole('toolbar')).getByRole('button', { name: /bold/i })).toBeTruthy();
    expect(within(screen.getByRole('toolbar')).getByRole('button', { name: /italic/i })).toBeTruthy();
    expect(container.querySelector('script, img, iframe, svg')).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|onclick|onload|javascript:/i);
    expect((window as any).__xss).toBe(0);
  });
  it('editor: the editing surface has a role and accessible name from the label; toolbar reachable by keyboard', async () => {
    render(<RichTextEditor label="Findings" name="findings" value="<p>x</p>" onChange={() => {}} maxLength={20000} allowed={ALL_TOOLS} />);
    expect(screen.getByRole('textbox', { name: /findings/i })).toBeTruthy();
    const u = user();
    await u.tab();
    expect(screen.getByRole('toolbar').contains(document.activeElement)).toBe(true);
  });
  it('editor: onChange never emits a disallowed tag even when the value prop changes', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<RichTextEditor label="Findings" name="findings" value="<p>a</p>" onChange={onChange} maxLength={20000} allowed={ALL_TOOLS} />);
    rerender(<RichTextEditor label="Findings" name="findings" value={evil} onChange={onChange} maxLength={20000} allowed={ALL_TOOLS} />);
    await waitFor(() => {});
    for (const c of onChange.mock.calls) expect(String(c[0])).not.toMatch(/<script|<img|<iframe|<svg|onerror|javascript:/i);
  });
  it('SafeHtml keeps the spec allowlist extras h3, h4 and table (same allowlist as the editor, C6 :320) but still strips handlers', () => {
    const { container } = render(<SafeHtml html={'<h3>Gross</h3><h4>Margins</h4><table><tbody><tr><td onclick="window.__xss=6">cell</td></tr></tbody></table>'} />);
    expect(container.querySelector('h3')?.textContent).toBe('Gross');
    expect(container.querySelector('h4')?.textContent).toBe('Margins');
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('td')?.textContent).toBe('cell');
    expect(container.innerHTML).not.toMatch(/onclick/i);
  });
  it('toolbar shows only the tools listed in `allowed`', () => {
    const { unmount } = render(<RichTextEditor label="Findings" name="findings" onChange={() => {}} maxLength={100} allowed={['italic', 'h3']} />);
    const bar = screen.getByRole('toolbar');
    expect(within(bar).getAllByRole('button')).toHaveLength(2);
    expect(within(bar).getByRole('button', { name: /italic/i })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: /\b(h3|heading 3|heading level 3)\b/i })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: /bold/i })).toBeNull();
    expect(within(bar).queryByRole('button', { name: /underline/i })).toBeNull();
    unmount();
    render(<RichTextEditor label="Findings" name="findings" onChange={() => {}} maxLength={100} allowed={ALL_TOOLS} />);
    expect(within(screen.getByRole('toolbar')).getAllByRole('button')).toHaveLength(8);
  });
  it('`value` is optional (renders an empty labelled editor)', () => {
    render(<RichTextEditor label="Findings" name="findings" maxLength={100} allowed={['bold']} />);
    expect(screen.getByRole('textbox', { name: /findings/i })).toBeTruthy();
  });
  it('maxLength counts text content chars, not serialised HTML length', () => {
    const invalid = (c: HTMLElement) => !!(c.querySelector('[aria-invalid="true"]') ?? screen.queryByRole('alert'));
    // html is 35 chars long, text is 4: must be within maxLength=10
    const ok = render(<RichTextEditor label="Findings" name="findings" value="<p><strong><em>abcd</em></strong></p>" onChange={() => {}} maxLength={10} allowed={ALL_TOOLS} />);
    expect(invalid(ok.container)).toBe(false);
    ok.unmount();
    // text is 12 chars: over maxLength=10
    const bad = render(<RichTextEditor label="Findings" name="findings" value="<p>abcdefghijkl</p>" onChange={() => {}} maxLength={10} allowed={ALL_TOOLS} />);
    expect(invalid(bad.container)).toBe(true);
  });
  it('axe clean', async () => {
    render(<RichTextEditor label="Findings" name="findings" value="<p>Normal <strong>mucosa</strong></p>" onChange={() => {}} maxLength={20000} allowed={ALL_TOOLS} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('KeyValueListEditor (C7)', () => {
  const Harness = ({ initial = [{ key: 'H', value: 'HIGH' }], maxRows = 20, onChange = () => {} }: { initial?: { key: string; value: string }[]; maxRows?: number; onChange?: (v: unknown) => void }) => {
    const [v, setV] = useState(initial);
    return <KeyValueListEditor label="Flag map" name="flagMap" value={v} onChange={(x: typeof v) => { setV(x); onChange(x); }} maxRows={maxRows} keyMaxLength={16} valueMaxLength={64} />;
  };
  it('renders one labelled key and value input per row with the spec lengths', () => {
    render(<Harness />);
    const boxes = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual(['H', 'HIGH']);
    expect(boxes[0].getAttribute('maxlength')).toBe('16');
    expect(boxes[1].getAttribute('maxlength')).toBe('64');
    for (const b of boxes) expect(b.getAttribute('aria-label') ?? document.querySelector(`label[for="${b.id}"]`)?.textContent ?? b.getAttribute('aria-labelledby')).toBeTruthy();
  });
  it('Add appends an empty row; Remove deletes that row; both work from the keyboard', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    screen.getAllByRole('button', { name: /remove/i })[0].focus();
    await u.keyboard('{Enter}');
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(onChange).toHaveBeenLastCalledWith([{ key: '', value: '' }]);
  });
  it('Add is disabled at maxRows', () => {
    render(<Harness maxRows={1} />);
    expect((screen.getByRole('button', { name: /add/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('Remove buttons are individually named (row identity in the name) so they are distinguishable', () => {
    render(<Harness initial={[{ key: 'H', value: 'HIGH' }, { key: 'L', value: 'LOW' }]} />);
    const names = screen.getAllByRole('button', { name: /remove/i }).map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(new Set(names).size).toBe(2);
  });
  it('axe clean', async () => {
    render(<Harness />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('PeriodPicker (C8)', () => {
  const PRESETS = ['Today', 'Yesterday', 'This B.S. month', 'Last B.S. month', 'This fiscal year', 'Last fiscal year', 'This A.D. month', 'Last A.D. month', 'Custom'];
  const ALL = ['today', 'yesterday', 'this_bs_month', 'last_bs_month', 'this_fy', 'last_fy', 'this_ad_month', 'last_ad_month', 'custom'] as const;
  it('lists the nine C8 presets, labelled, via keyboard', async () => {
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'today' }} presets={ALL} onChange={() => {}} calendar="BS" />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /period/i }));
    const opts = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    for (const p of PRESETS) expect(opts).toContain(p);
  });
  it('`presets` limits the list to exactly the given options, in the given order (C4 reuse)', async () => {
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'today' }} presets={['today', 'this_ad_month', 'custom']} onChange={() => {}} calendar="AD" />);
    await user().click(screen.getByRole('button', { name: /period/i }));
    const opts = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['Today', 'This A.D. month', 'Custom']);
  });
  it('choosing a preset reports its id', async () => {
    const onChange = vi.fn();
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'today' }} presets={ALL} onChange={onChange} calendar="AD" />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /period/i }));
    await u.click(await screen.findByRole('option', { name: 'Yesterday' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ preset: 'yesterday' }));
  });
  it('custom shows From/To inputs; a range over 366 days shows a text error (no silent clamp)', () => {
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'custom', from: '2026-01-01', to: '2027-06-01' }} presets={ALL} onChange={() => {}} calendar="AD" />);
    expect(screen.getByText(/366/)).toBeTruthy();
  });
  it('custom range of exactly 366 days is accepted (boundary)', () => {
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'custom', from: '2026-01-01', to: '2027-01-01' }} presets={ALL} onChange={() => {}} calendar="AD" />);
    expect(screen.queryByText(/366/)).toBeNull();
  });
  it('from after to is an error too', () => {
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'custom', from: '2026-05-02', to: '2026-05-01' }} presets={ALL} onChange={() => {}} calendar="AD" />);
    expect(screen.queryByRole('alert') ?? screen.queryByText(/before|after|earlier/i)).toBeTruthy();
  });
  it('axe clean', async () => {
    render(<PeriodPicker label="Period" name="period" value={{ preset: 'today' }} presets={ALL} onChange={() => {}} calendar="BS" />);
    expect(await seriousViolations()).toEqual([]);
  });
});
