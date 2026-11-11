// @vitest-environment jsdom
// T0D-13 / AC-0D-8.4 + 04-UI-UX §2.4 (BarcodeInput, useScanCapture) + REQ-SEC-098 / 07-SECURITY:181 (never log/persist/URL a scanned value).
// "scanner timing simulation": vitest fake clock (Date + performance) + user-event `delay` = the gap between two key presses.
// ASSUMED (spec gives behaviour, not file layout): `BarcodeInput` AND `useScanCapture` are both exported from components/BarcodeInput/BarcodeInput.tsx
//   (package exports map is one .tsx per folder). Timing must be read from Date.now()/performance.now() (NOT event.timeStamp, which a fake clock cannot move).
//   Live region = any element with role=status|alert or aria-live whose text contains "Scanned" / "Invalid barcode" (04-UI-UX §5.5).
//   Tone: AudioContext (WebAudio, 04-UI-UX §2.4.2) is only constructed for feedback 'sound+visual'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BarcodeInput, useScanCapture } from '../BarcodeInput/BarcodeInput';
import { seriousViolations } from './helpers';

// RTL's default asyncWrapper drains with setTimeout(0) and only knows jest's fake timers -> it would hang under vitest's fake clock.
// Same wrapper minus the drain (verified: user-event gaps equal `delay` exactly on the fake clock).
configure({
  asyncWrapper: async (cb) => {
    const g = globalThis as any;
    const prev = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      return await cb();
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prev;
    }
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'], now: 1_800_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** user whose key presses are exactly `gap` ms apart on the fake clock */
const typist = (gap: number) => userEvent.setup({ delay: gap, advanceTimers: vi.advanceTimersByTime });
const idle = (ms: number) => vi.advanceTimersByTime(ms);
const liveText = () => [...document.querySelectorAll('[role=status],[role=alert],[aria-live]')].map((e) => e.textContent ?? '').join(' | ');
const FAST = 10; // <= 30 ms: keyboard-wedge scanner
const SLOW = 120; // human

function setup(props: Partial<React.ComponentProps<typeof BarcodeInput>> = {}) {
  const onScan = vi.fn();
  const utils = render(<BarcodeInput label="Specimen barcode" name="barcode" onScan={onScan} {...props} />);
  const input = screen.getByRole('textbox', { name: /specimen barcode/i }) as HTMLInputElement;
  return { onScan, input, ...utils };
}

describe('BarcodeInput: scanner vs keyboard (AC-0D-8.4, 04-UI-UX §2.4.1-3)', () => {
  it('is focused on mount (autoFocus default true) so staff can scan without clicking', () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
  });

  it('autoFocus={false} leaves focus alone', () => {
    const { input } = setup({ autoFocus: false });
    expect(document.activeElement).not.toBe(input);
  });

  it('keys <= 30 ms apart + Enter -> onScan fires ONCE with the UPPERCASED value and source "scanner"', async () => {
    const { onScan } = setup();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    const [value, meta] = onScan.mock.calls[0]!;
    expect(value).toBe('AB12CD34');
    expect(meta.source).toBe('scanner');
    expect(typeof meta.durationMs).toBe('number');
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(meta.durationMs).toBeLessThan(400); // 8 chars x 10 ms, not the wall clock of the whole test
  });

  it('Tab is a default submit key too', async () => {
    const { onScan } = setup();
    await typist(FAST).keyboard('ab12cd34{Tab}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![1].source).toBe('scanner');
  });

  it('submitKeys=["Enter"] -> Tab does not submit', async () => {
    const { onScan } = setup({ submitKeys: ['Enter'] });
    await typist(FAST).keyboard('ab12cd34{Tab}');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('boundary: gap of exactly 30 ms is still a scanner, 31 ms is a keyboard (default scannerMaxInterKeyMs 30)', async () => {
    const a = setup();
    await typist(30).keyboard('ab12cd{Enter}');
    expect(a.onScan.mock.calls[0]![1].source).toBe('scanner');
    a.unmount();
    const b = setup();
    await typist(31).keyboard('ab12cd{Enter}');
    expect(b.onScan.mock.calls[0]![1].source).toBe('keyboard');
  });

  it('a single slow gap in the run disqualifies it (every gap must be <= max)', async () => {
    const { onScan, input } = setup();
    const u = typist(FAST);
    await u.keyboard('ab12');
    idle(200);
    await u.keyboard('cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('AB12CD34');
    expect(onScan.mock.calls[0]![1].source).toBe('keyboard');
    expect(input.value).toBe('');
  });

  it('the gap between the last character and the submit key counts too: fast chars, 100 ms pause, Enter -> keyboard', async () => {
    const { onScan } = setup();
    const u = typist(FAST);
    await u.keyboard('ab12');
    idle(100);
    await u.keyboard('{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('AB12');
    expect(onScan.mock.calls[0]![1].source).toBe('keyboard');
  });

  it('idle time BEFORE the first key does not matter', async () => {
    const { onScan } = setup();
    idle(60_000);
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan.mock.calls[0]![1].source).toBe('scanner');
  });

  it('manual typing (slow keys) + Enter -> source "keyboard" (allowManual default true)', async () => {
    const { onScan } = setup();
    await typist(SLOW).keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('AB12CD34');
    expect(onScan.mock.calls[0]![1].source).toBe('keyboard');
    expect(onScan.mock.calls[0]![1].durationMs).toBeGreaterThanOrEqual(SLOW * 7);
  });

  it('allowManual={false}: slow typing does not fire onScan; a real scan still does', async () => {
    const { onScan, input } = setup({ allowManual: false });
    await typist(SLOW).keyboard('ab12cd34{Enter}');
    expect(onScan).not.toHaveBeenCalled();
    // field is cleaned/selected so a following scan is not appended to the manual text
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).clear(input);
    idle(5000);
    await typist(FAST).keyboard('zz99yy88{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('ZZ99YY88');
  });

  it('a run shorter than minScanLength (default 4) is never classed "scanner" even when fast', async () => {
    const { onScan } = setup();
    await typist(FAST).keyboard('ab1{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![1].source).toBe('keyboard');
  });

  it('minScanLength is configurable', async () => {
    const { onScan } = setup({ minScanLength: 8 });
    await typist(FAST).keyboard('ab12cd{Enter}');
    expect(onScan.mock.calls[0]![1].source).toBe('keyboard');
  });

  it('scannerMaxInterKeyMs is configurable', async () => {
    const { onScan } = setup({ scannerMaxInterKeyMs: 80 });
    await typist(60).keyboard('ab12cd34{Enter}');
    expect(onScan.mock.calls[0]![1].source).toBe('scanner');
  });

  it('trims surrounding whitespace before validating', async () => {
    const { onScan } = setup();
    await typist(FAST).keyboard('ab12cd34 {Enter}');
    expect(onScan.mock.calls[0]![0]).toBe('AB12CD34');
  });

  it('clearAfterScan (default true) empties the field after a valid scan; false keeps it', async () => {
    const a = setup();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(a.input.value).toBe('');
    a.unmount();
    const b = setup({ clearAfterScan: false });
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(b.input.value.toUpperCase()).toBe('AB12CD34');
  });

  it('announces "Scanned" in a live region on success (04-UI-UX §5.5)', async () => {
    setup();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(liveText()).toMatch(/Scanned/);
  });
});

describe('BarcodeInput: validation against [A-Z0-9]{1,20} (AC-0D-8.4, 04-UI-UX §2.4.2)', () => {
  const INVALID = [
    ['punctuation', 'ab-12-cd'],
    ['inner space', 'ab 12'],
    ['21 characters', 'a'.repeat(21)],
    ['Devanagari', 'सुनिता'],
    ['markup', '<b>1</b>'],
  ] as const;

  it.each(INVALID)('%s: no onScan, inline error text, error live region, text stays selected for re-scan', async (_n, text) => {
    const { onScan, input } = setup();
    await typist(FAST).keyboard(`${text}{Enter}`);
    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByText("This doesn't look like a sample barcode")).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toMatch(/doesn't look like a sample barcode/);
    expect(liveText()).toMatch(/Invalid barcode/);
    expect(input.value).not.toBe(''); // text kept...
    expect(input.selectionStart).toBe(0); // ...and selected
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('exactly 20 characters is valid (upper bound of the charset rule)', async () => {
    const { onScan } = setup();
    await typist(FAST).keyboard(`${'a1'.repeat(10)}{Enter}`);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('empty Enter does nothing (no onScan, no error flash)', async () => {
    const { onScan } = setup();
    await typist(FAST).keyboard('{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('the error clears after the next valid scan', async () => {
    const { onScan, input } = setup();
    const u = typist(FAST);
    await u.keyboard('ab-12{Enter}');
    expect(screen.queryByText("This doesn't look like a sample barcode")).toBeTruthy();
    await u.keyboard('{Control>}a{/Control}{Backspace}');
    idle(5000);
    await u.keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("This doesn't look like a sample barcode")).toBeNull();
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('a custom pattern replaces the default', async () => {
    const { onScan } = setup({ pattern: /^SP-\d{4}$/ });
    const u = typist(FAST);
    await u.keyboard('sp-0042{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('SP-0042');
  });
});

describe('BarcodeInput: duplicate scans (04-UI-UX §2.4.4)', () => {
  it('identical scan within 1,500 ms is ignored with a visible hint; after 1,500 ms it fires again', async () => {
    const { onScan } = setup();
    const u = typist(FAST);
    await u.keyboard('ab12cd34{Enter}');
    idle(500);
    await u.keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/duplicate scan ignored/i)).toBeTruthy();
    idle(2000);
    await u.keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT value right after a scan is not a duplicate', async () => {
    const { onScan } = setup();
    const u = typist(FAST);
    await u.keyboard('ab12cd34{Enter}');
    idle(100);
    await u.keyboard('zz99yy88{Enter}');
    expect(onScan).toHaveBeenCalledTimes(2);
  });
});

describe('BarcodeInput: field contract and feedback', () => {
  it('label, name, error and isDisabled follow the FieldBase contract', () => {
    const { input } = setup({ error: 'Scan the tube barcode' });
    expect(input.name).toBe('barcode');
    expect(screen.getByText('Scan the tube barcode')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('isDisabled: input disabled and nothing fires', async () => {
    const { onScan, input } = setup({ isDisabled: true });
    expect(input.disabled).toBe(true);
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });

  function stubAudio() {
    const ctor = vi.fn(function () {
      const node: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : node), apply: () => node, set: () => true });
      return node;
    });
    vi.stubGlobal('AudioContext', ctor);
    vi.stubGlobal('webkitAudioContext', ctor);
    return ctor;
  }

  it("feedback 'sound+visual' (default): a valid scan plays a WebAudio tone", async () => {
    const ctor = stubAudio();
    setup();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(ctor).toHaveBeenCalled();
  });

  it("feedback 'visual': no AudioContext is ever created", async () => {
    const ctor = stubAudio();
    setup({ feedback: 'visual' });
    await typist(FAST).keyboard('ab12cd34{Enter}');
    await typist(FAST).keyboard('ab-12{Enter}');
    expect(ctor).not.toHaveBeenCalled();
  });

  it('works when AudioContext does not exist (jsdom, locked-down kiosk): scan still fires, nothing throws', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const { onScan } = setup();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('axe: idle, with error, disabled -> no critical/serious violation (AC-0D-8.6)', async () => {
    vi.useRealTimers(); // fake setTimeout (file-wide) starves axe-core's internal timers
    const a = setup();
    expect(await seriousViolations()).toEqual([]);
    a.unmount();
    const b = setup({ error: 'Scan the tube barcode' });
    expect(await seriousViolations()).toEqual([]);
    b.unmount();
    setup({ isDisabled: true });
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('BarcodeInput / useScanCapture never log, persist or URL-encode a value (REQ-SEC-098, 07-SECURITY:181, 04-UI-UX §2.4.6)', () => {
  const SECRET = 'PHI9ZZ42';
  function Capture(p: { onScan: any; enabled?: boolean; pattern?: RegExp; scannerMaxInterKeyMs?: number }) {
    useScanCapture({ enabled: true, ...p });
    return null;
  }

  it('no console.*, no Web Storage write, no history/URL change while scanning (input and hook, valid and invalid)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    const href = location.href;
    const u = typist(FAST);

    const a = setup();
    await u.keyboard(`${SECRET.toLowerCase()}{Enter}`);
    idle(3000);
    await u.keyboard('bad-value!{Enter}');
    a.unmount();

    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    (document.activeElement as HTMLElement | null)?.blur();
    await u.keyboard(`${SECRET.toLowerCase()}{Enter}`);

    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(location.href).toBe(href);
    expect(location.href).not.toContain(SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(document.cookie).not.toContain(SECRET);
  });
});

describe('useScanCapture (04-UI-UX §2.4.5)', () => {
  function Capture(p: { onScan: any; enabled?: boolean; pattern?: RegExp; scannerMaxInterKeyMs?: number }) {
    useScanCapture({ enabled: true, ...p });
    return (
      <div>
        <input aria-label="Patient note" />
        <textarea aria-label="Comment" />
        <select aria-label="Choice">
          <option>one</option>
        </select>
      </div>
    );
  }

  it('enabled + nothing focused: a fast run ending in Enter fires onScan once with the uppercased value, source "scanner"', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('AB12CD34');
    expect(onScan.mock.calls[0]![1].source).toBe('scanner');
    expect(typeof onScan.mock.calls[0]![1].durationMs).toBe('number');
  });

  it('enabled={false}: nothing fires', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} enabled={false} />);
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('switching enabled true -> false -> true attaches and detaches the listener', async () => {
    const onScan = vi.fn();
    const { rerender } = render(<Capture onScan={onScan} enabled />);
    rerender(<Capture onScan={onScan} enabled={false} />);
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).not.toHaveBeenCalled();
    rerender(<Capture onScan={onScan} enabled />);
    idle(2000);
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it.each([['input', 'Patient note'], ['textarea', 'Comment']])('ignores keys while an editable element (%s) has focus', async (_k, name) => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    (screen.getByLabelText(name) as HTMLElement).focus();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('after the editable element loses focus, capture resumes', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    const input = screen.getByLabelText('Patient note') as HTMLElement;
    input.focus();
    input.blur();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('a run that does not match the pattern does not fire', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    await typist(FAST).keyboard('ab-12!{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('slow typing is never reported as source "scanner"', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    await typist(SLOW).keyboard('ab12cd34{Enter}');
    for (const c of onScan.mock.calls) expect(c[1].source).not.toBe('scanner');
  });

  it('custom pattern and scannerMaxInterKeyMs are honoured', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} pattern={/^SP-\d{4}$/} scannerMaxInterKeyMs={80} />);
    await typist(60).keyboard('sp-0042{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0]![0]).toBe('SP-0042');
    expect(onScan.mock.calls[0]![1].source).toBe('scanner');
  });

  it('two scans in a row each fire once (buffer is reset after a submit)', async () => {
    const onScan = vi.fn();
    render(<Capture onScan={onScan} />);
    const u = typist(FAST);
    await u.keyboard('ab12cd34{Enter}');
    idle(2000);
    await u.keyboard('zz99yy88{Enter}');
    expect(onScan.mock.calls.map((c) => c[0])).toEqual(['AB12CD34', 'ZZ99YY88']);
  });

  it('unmount removes the document listener', async () => {
    const onScan = vi.fn();
    const { unmount } = render(<Capture onScan={onScan} />);
    unmount();
    await typist(FAST).keyboard('ab12cd34{Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('uses the latest onScan callback without re-subscribing mid-run', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Capture onScan={first} />);
    const u = typist(FAST);
    await u.keyboard('ab12');
    rerender(<Capture onScan={second} />);
    await u.keyboard('cd34{Enter}');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]![0]).toBe('AB12CD34');
  });
});
