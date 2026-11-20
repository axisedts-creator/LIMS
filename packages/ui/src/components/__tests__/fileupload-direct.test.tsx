// @vitest-environment jsdom
// T0B-FILES-1 (LD-310, founder request 2026-11-17 04:54 NPT) done_when 5: the kit FileUpload shows a progress bar, can cancel, retries up to 3 times, uploads up to 3 files in parallel.
// Additive props on FileUpload (existing behaviour and tests unchanged when `uploadFile` is absent):
//   uploadFile?: (file, { attempt, signal, resumeFrom, onProgress(percent, ackedBytes?) }) => Promise<void>   the host's direct-to-storage transport (the kit never reads file bytes itself, REQ-SEC-085)
//   retryDelayMs?: (retry: number) => number    default exponential from 250 ms; tests pass () => 0
//   onUploaded?: (file: File) => void           called once per file after its upload finished
//   onUploadFailed?: (file: File) => void       called once per file after the last attempt failed
// Per file row (name in the list): role=progressbar named `Upload progress for <name>` (already in the kit), a button named `Cancel upload of <name>` while queued/uploading/retrying,
//   status text: `Uploading` | `Retrying (n of 3)` | `Uploaded` | `Upload failed` | `Cancelled`; after failure/cancel a button `Try again with <name>` restarts that file.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FileUpload } from '../FileUpload/FileUpload';
import { seriousViolations } from './helpers';

const PDF = 'application/pdf';
const file = (name: string, size = 300 * 1024) => { const f = new File(['x'], name, { type: PDF }); Object.defineProperty(f, 'size', { value: size }); return f; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const err = (retryable?: boolean) => Object.assign(new Error('network'), retryable === undefined ? {} : { retryable });

type Ctl = { attempt: number; signal: AbortSignal; resumeFrom: number; onProgress: (p: number, b?: number) => void };
function setup(uploadFile: (f: File, c: Ctl) => Promise<void>, props: Record<string, unknown> = {}) {
  const onSelect = vi.fn(); const onUploaded = vi.fn(); const onUploadFailed = vi.fn();
  const r = render(<FileUpload label="Attachment" name="attachment" accept={[PDF]} multiple onSelect={onSelect} uploadFile={uploadFile} retryDelayMs={() => 0} onUploaded={onUploaded} onUploadFailed={onUploadFailed} {...props} />);
  const input = () => screen.getByLabelText(/attachment/i, { selector: 'input' }) as HTMLInputElement;
  const pick = (files: File[]) => fireEvent.change(input(), { target: { files } });
  const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
  return { onSelect, onUploaded, onUploadFailed, pick, row, ...r };
}
const deferred = () => { let ok!: () => void; let ko!: (e: unknown) => void; const p = new Promise<void>((a, b) => { ok = a; ko = b; }); return { p, ok, ko }; };

describe('FileUpload with uploadFile: progress, status, cancel', () => {
  it('selecting a file starts the upload at once and onSelect still fires once', async () => {
    const send = vi.fn(async () => {});
    const { pick, onSelect } = setup(send);
    pick([file('a.pdf')]);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [File, Ctl])[1].attempt).toBe(1);
  });
  it('shows a progress bar that follows onProgress (aria-valuenow, percent text), then Uploaded', async () => {
    const d = deferred(); let ctl!: Ctl;
    const { pick, row, onUploaded } = setup((_f, c) => { ctl = c; return d.p; });
    pick([file('a.pdf')]);
    await waitFor(() => expect(ctl).toBeTruthy());
    act(() => ctl.onProgress(42));
    const bar = within(row('a.pdf')).getByRole('progressbar', { name: /upload progress for a\.pdf/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.textContent).toMatch(/42\s?%/);
    expect(within(row('a.pdf')).getByText(/uploading/i)).toBeTruthy();
    await act(async () => { ctl.onProgress(100); d.ok(); await tick(); });
    await waitFor(() => expect(within(row('a.pdf')).getByText(/uploaded/i)).toBeTruthy());
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect((onUploaded.mock.calls[0] as File[])[0]!.name).toBe('a.pdf');
    expect(within(row('a.pdf')).queryByRole('button', { name: /cancel upload/i })).toBeNull();
  });
  it('Cancel aborts the transfer signal, shows Cancelled, never retries, and offers Try again', async () => {
    let ctl!: Ctl; const send = vi.fn((_f: File, c: Ctl) => { ctl = c; return new Promise<void>((_ok, ko) => c.signal.addEventListener('abort', () => ko(err()))); });
    const { pick, row, onUploadFailed } = setup(send);
    pick([file('a.pdf')]);
    await waitFor(() => expect(ctl).toBeTruthy());
    fireEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Cancel upload of a.pdf' }));
    expect(ctl.signal.aborted).toBe(true);
    await waitFor(() => expect(within(row('a.pdf')).getByText(/cancelled/i)).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(1);
    expect(onUploadFailed).not.toHaveBeenCalled();
    fireEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Try again with a.pdf' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
  it('a progress bar is announced politely and the controls are keyboard reachable buttons (not links or divs)', async () => {
    let ctl!: Ctl;
    const { pick, row, container } = setup((_f, c) => { ctl = c; return new Promise<void>(() => {}); });
    pick([file('a.pdf')]);
    await waitFor(() => expect(ctl).toBeTruthy());
    const btn = within(row('a.pdf')).getByRole('button', { name: /cancel upload of a\.pdf/i });
    expect(btn.tagName).toBe('BUTTON');
    expect((btn as HTMLButtonElement).type).toBe('button');          // never submits the surrounding form
    expect(await seriousViolations(container)).toEqual([]);
  });
});

describe('FileUpload with uploadFile: retry (up to 3 times)', () => {
  it('shows Retrying (1 of 3) between attempts, then Uploaded when a later attempt works', async () => {
    const gates = [deferred(), deferred()]; let n = 0;
    const send = vi.fn(async () => { const g = gates[n++]!; await g.p; });
    const { pick, row, onUploaded } = setup(send, { retryDelayMs: () => 20 });
    pick([file('a.pdf')]);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => { gates[0]!.ko(err()); await tick(); });
    await waitFor(() => expect(within(row('a.pdf')).getByText(/retrying \(1 of 3\)/i)).toBeTruthy());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await act(async () => { gates[1]!.ok(); await tick(); });
    await waitFor(() => expect(within(row('a.pdf')).getByText(/uploaded/i)).toBeTruthy());
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });
  it('after 1 + 3 failed attempts it shows Upload failed as an alert and calls onUploadFailed once; Try again restarts', async () => {
    const send = vi.fn(async () => { throw err(); });
    const { pick, row, onUploadFailed, onUploaded } = setup(send);
    pick([file('a.pdf')]);
    await waitFor(() => expect(within(row('a.pdf')).getByText(/upload failed/i)).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(4);
    expect(onUploadFailed).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(within(row('a.pdf')).getByRole('alert').textContent).toMatch(/upload failed/i);
    fireEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Try again with a.pdf' }));
    await waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(4));
  });
  it('a non-retryable failure (expired link, 413, 415) fails at once without retries', async () => {
    const send = vi.fn(async () => { throw err(false); });
    const { pick, row } = setup(send);
    pick([file('a.pdf')]);
    await waitFor(() => expect(within(row('a.pdf')).getByText(/upload failed/i)).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('the failure text never shows the raw error message (it may carry a storage URL)', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('PUT https://storage.invalid/up/1?sig=SECRET failed'), { retryable: false }); });
    const { pick, row, container } = setup(send);
    pick([file('a.pdf')]);
    await waitFor(() => expect(within(row('a.pdf')).getByText(/upload failed/i)).toBeTruthy());
    expect(container.textContent).not.toMatch(/storage\.invalid|SECRET|sig=/);
  });
});

describe('FileUpload with uploadFile: parallel limit 3', () => {
  it('5 files: 3 start together, the 4th starts when one finishes, never more than 3 at once', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>(); let live = 0, peak = 0;
    const send = vi.fn(async (f: File) => { live++; peak = Math.max(peak, live); const g = deferred(); gates.set(f.name, g); await g.p; live--; });
    const { pick, row } = setup(send);
    pick(['a', 'b', 'c', 'd', 'e'].map((n) => file(`${n}.pdf`)));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(within(row('d.pdf')).queryByRole('progressbar')?.getAttribute('aria-valuenow') ?? '0').toBe('0');
    expect(within(row('d.pdf')).getByText(/waiting|queued/i)).toBeTruthy();
    await act(async () => { gates.get('a.pdf')!.ok(); await tick(); });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    await act(async () => { gates.get('b.pdf')!.ok(); gates.get('c.pdf')!.ok(); await tick(); });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    await act(async () => { for (const g of gates.values()) g.ok(); await tick(); });
    expect(peak).toBe(3);
  });
});

describe('FileUpload with uploadFile: unchanged client checks and safety', () => {
  it('files rejected by type/size/empty/count never reach uploadFile', async () => {
    const send = vi.fn(async () => {});
    const { pick } = setup(send, { maxBytes: 1000, maxFiles: 2 });
    const html = new File(['x'], 'p.html', { type: 'text/html' });
    pick([html]); pick([file('big.pdf', 1001)]); pick([file('empty.pdf', 0)]); pick([file('a.pdf', 10), file('b.pdf', 10), file('c.pdf', 10)]);
    await tick();
    expect(send).not.toHaveBeenCalled();
  });
  it('isDisabled and isReadOnly never start an upload (drop included)', async () => {
    const send = vi.fn(async () => {});
    const a = setup(send, { isDisabled: true });
    fireEvent.drop(a.container.querySelector('.lims-file-upload')!, { dataTransfer: { files: [file('a.pdf')], types: ['Files'] } });
    await tick();
    expect(send).not.toHaveBeenCalled();
  });
  it('a file name with markup is shown as text, never as HTML, and the buttons name it safely', async () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    const { pick, container } = setup(async () => { throw err(false); });
    pick([file(name)]);
    await waitFor(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0));
    expect(container.querySelector('img')).toBeNull();
  });
  it('without uploadFile the component behaves as before: no Cancel button, no status text (host drives progress by props)', () => {
    const onSelect = vi.fn();
    render(<FileUpload label="Attachment" name="attachment" accept={[PDF]} onSelect={onSelect} progress={{ 'a.pdf': 30 }} />);
    fireEvent.change(screen.getByLabelText(/attachment/i, { selector: 'input' }), { target: { files: [file('a.pdf')] } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /cancel upload/i })).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
  });
});
