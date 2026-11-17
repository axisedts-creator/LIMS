// 04-UI-UX §2.4. Keyboard-wedge scanners type fast and end with Enter/Tab (00 B1).
// Barcodes are PHI-class P2: this file never logs, stores or URL-encodes a value (CV §9.2, REQ-SEC-098).
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export type ScanMeta = { source: 'scanner' | 'keyboard'; durationMs: number };
export type OnScan = (value: string, meta: ScanMeta) => void;

export interface BarcodeInputProps {
  label: string;
  name: string;
  onScan: OnScan;
  /** Default /^[A-Z0-9]{1,20}$/ (IC §9.3 barcode charset). */
  pattern?: RegExp;
  /** Default true. */
  autoFocus?: boolean;
  /** Default 30 [CONV]. */
  scannerMaxInterKeyMs?: number;
  /** Default 4. */
  minScanLength?: number;
  /** Default ['Enter','Tab']. */
  submitKeys?: readonly ('Enter' | 'Tab')[];
  /** Default true. */
  allowManual?: boolean;
  /** Default true. */
  clearAfterScan?: boolean;
  /** Default 'sound+visual'. */
  feedback?: 'sound+visual' | 'visual';
  isDisabled?: boolean;
  error?: string;
  'data-testid'?: string;
}

const DEFAULT_PATTERN = /^[A-Z0-9]{1,20}$/;
const DUPLICATE_MS = 1500; // [CONV] 04-UI-UX §2.4.4
const MIN_SCAN = 4;
const text = {
  invalid: "This doesn't look like a sample barcode", // ui.barcode.invalid
  scanned: 'Scanned',
  invalidLive: 'Invalid barcode',
  duplicate: 'Duplicate scan ignored',
};
const now = () => performance.now();

/** Tracks one run of keys: every gap must be <= max for the run to count as a scanner. */
function useRun() {
  const run = useRef<{ start: number; last: number; slow: boolean } | null>(null);
  return {
    key(max: number) {
      const t = now();
      const r = run.current;
      if (!r) run.current = { start: t, last: t, slow: false };
      else {
        if (t - r.last > max) r.slow = true;
        r.last = t;
      }
    },
    /** Ends the run; returns classification inputs. */
    end(max: number): { slow: boolean; durationMs: number } {
      const r = run.current;
      run.current = null;
      const t = now();
      // 04-UI-UX §2.4 rule 1: the gap before the submit key counts too.
      return r ? { slow: r.slow || t - r.last > max, durationMs: Math.max(0, t - r.start) } : { slow: true, durationMs: 0 };
    },
    reset() {
      run.current = null;
    },
  };
}

/** ~80 ms WebAudio tone; silently does nothing where WebAudio is missing or blocked. */
function useTone(enabled: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  return (ok: boolean) => {
    if (!enabled) return;
    try {
      const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = g.AudioContext ?? g.webkitAudioContext;
      if (!Ctor) return;
      ctx.current ??= new Ctor();
      const c = ctx.current;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.value = 0.1;
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + 0.08);
    } catch {
      /* no sound is fine; the visual feedback still runs */
    }
  };
}

const isPrintable = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

export function BarcodeInput({
  label,
  name,
  onScan,
  pattern = DEFAULT_PATTERN,
  autoFocus = true,
  scannerMaxInterKeyMs = 30,
  minScanLength = 4,
  submitKeys = ['Enter', 'Tab'],
  allowManual = true,
  clearAfterScan = true,
  feedback = 'sound+visual',
  isDisabled,
  error,
  ...rest
}: BarcodeInputProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const run = useRun();
  const tone = useTone(feedback === 'sound+visual');
  const last = useRef<{ value: string; at: number } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [live, setLive] = useState('');
  const [hint, setHint] = useState('');
  const [flash, setFlash] = useState<'ok' | 'bad' | undefined>();

  useEffect(() => {
    if (autoFocus && !isDisabled) input.current?.focus();
  }, [autoFocus, isDisabled]);

  const select = (el: HTMLInputElement) => el.setSelectionRange(0, el.value.length);

  const submit = (el: HTMLInputElement) => {
    const value = el.value.trim().toUpperCase();
    const { slow, durationMs } = run.end(scannerMaxInterKeyMs);
    if (value === '') return false;
    const source: ScanMeta['source'] = !slow && value.length >= minScanLength ? 'scanner' : 'keyboard';
    if (!pattern.test(value)) {
      setInvalid(true);
      setHint('');
      setLive(text.invalidLive);
      setFlash('bad');
      tone(false);
      select(el);
      return true;
    }
    if (source === 'keyboard' && !allowManual) {
      select(el);
      return true;
    }
    setInvalid(false);
    const t = now();
    if (last.current && last.current.value === value && t - last.current.at < DUPLICATE_MS) {
      setHint(text.duplicate);
      if (clearAfterScan) el.value = '';
      return true;
    }
    last.current = { value, at: t };
    setHint('');
    setLive(text.scanned);
    setFlash('ok');
    tone(true);
    if (clearAfterScan) el.value = '';
    onScan(value, { source, durationMs });
    return true;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isDisabled) return;
    if ((submitKeys as readonly string[]).includes(e.key)) {
      if (submit(e.currentTarget)) e.preventDefault();
      return;
    }
    if (isPrintable(e)) {
      if (flash) setFlash(undefined);
      run.key(scannerMaxInterKeyMs);
    }
  };

  const shown = invalid ? text.invalid : error;
  const ids = { err: `${id}-e`, hint: `${id}-h` };
  const describedBy = [shown && ids.err, hint && ids.hint].filter(Boolean).join(' ');

  return (
    <div className="lims-field lims-barcode" {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}>
      <label className="lims-label" htmlFor={id}>
        {label}
      </label>
      <input
        ref={input}
        id={id}
        name={name}
        type="text"
        className={`lims-input lims-mono${flash ? ` lims-scan-${flash}` : ''}`}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        disabled={isDisabled}
        aria-invalid={shown ? true : undefined}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        onKeyDown={onKeyDown}
        onInput={(e) => {
          if (e.currentTarget.value === '') run.reset();
        }}
      />
      {shown ? (
        <p id={ids.err} className="lims-error">
          {shown}
        </p>
      ) : null}
      {hint ? (
        <p id={ids.hint} className="lims-description" aria-live="polite">
          {hint}
        </p>
      ) : null}
      <span role="status" className="lims-visually-hidden">
        {live}
      </span>
    </div>
  );
}

const isEditable = (el: Element | null) =>
  !!el && ((el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * Document-level scan capture for scan-first screens (04-UI-UX §2.4.5): active while `enabled` and no editable element has focus.
 * A slow key starts a new run, so ordinary typing/shortcuts never reach `onScan`; only scanner-speed runs that match `pattern` do.
 */
export function useScanCapture(opts: { onScan: OnScan; enabled: boolean; pattern?: RegExp; scannerMaxInterKeyMs?: number }): void {
  const ref = useRef(opts);
  ref.current = opts;
  const { enabled } = opts;
  useEffect(() => {
    if (!enabled) return;
    let buf = '';
    let start = 0;
    let lastKey = 0;
    let lastScan: { value: string; at: number } | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(document.activeElement)) return;
      const max = ref.current.scannerMaxInterKeyMs ?? 30;
      const t = now();
      if (e.key === 'Enter' || e.key === 'Tab') {
        const value = buf.trim().toUpperCase();
        const fast = buf.length >= MIN_SCAN && t - lastKey <= max;
        const durationMs = t - start;
        buf = '';
        if (!fast || !(ref.current.pattern ?? DEFAULT_PATTERN).test(value)) return;
        e.preventDefault();
        if (lastScan && lastScan.value === value && t - lastScan.at < DUPLICATE_MS) return;
        lastScan = { value, at: t };
        ref.current.onScan(value, { source: 'scanner', durationMs });
        return;
      }
      if (!isPrintable(e)) return;
      if (buf === '' || t - lastKey > max) {
        buf = '';
        start = t;
      }
      buf += e.key;
      lastKey = t;
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
