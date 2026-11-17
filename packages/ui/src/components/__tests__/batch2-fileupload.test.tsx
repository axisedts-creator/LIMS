// @vitest-environment jsdom
// T0D-13 / 04-UI-UX §2.2 FileUpload (+ scanState, csv/xlsx accept — CR-C4/C10/C3), REQ-SEC-083 (client hints: type, 15 MB), REQ-SEC-085 (never preview an untrusted
// file inline on the app origin), REQ-SEC-088, AC-0D-8.6.
// ASSUMED: the file picker is an <input type=file> reachable by its label; `progress` and `scanState` are keyed by FILE NAME (spec: "Record<string,…>, per file");
//   selected file names are listed as text; progress is role=progressbar with aria-valuenow; scan state words appear as text (pending|scanning, clean, infected,
//   unavailable); a rejection is shown as text matching /too large|exceeds|larger|15 ?MB/ (size), /not allowed|unsupported|type|format/ (type), /too many|at most|maximum|no more than/ (count).
//   The component validates itself (accept/size/count) - user-event's applyAccept is switched off so the component, not the test harness, must reject.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileUpload } from '../FileUpload/FileUpload';
import { DEVANAGARI, XSS, seriousViolations } from './helpers';

const MB = 1024 * 1024;
const file = (name: string, type: string, size = 100) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function setup(props: Partial<React.ComponentProps<typeof FileUpload>> = {}) {
  const onSelect = vi.fn();
  const r = render(<FileUpload label="Attachment" name="attachment" accept={[PDF, 'image/png']} onSelect={onSelect} {...props} />);
  const input = () => screen.getByLabelText(/attachment/i, { selector: 'input' }) as HTMLInputElement;
  const pick = (files: File[]) => fireEvent.change(input(), { target: { files } });
  return { onSelect, input, pick, ...r };
}
const selectedFiles = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.flatMap((c) => c[0] as File[]);

describe('FileUpload: picking (REQ-SEC-083)', () => {
  it('input type=file named by the label; accept attribute is the accept list; name is set', () => {
    const { input } = setup({ accept: [PDF, 'image/jpeg', 'text/csv', XLSX] });
    expect(input().type).toBe('file');
    expect(input().name).toBe('attachment');
    expect(input().accept.split(',').map((s) => s.trim())).toEqual([PDF, 'image/jpeg', 'text/csv', XLSX]);
  });

  it('a valid file -> onSelect([file]) exactly once', async () => {
    const { onSelect, input } = setup();
    const f = file('report.pdf', PDF);
    await userEvent.setup({ applyAccept: false }).upload(input(), f);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toEqual([f]);
  });

  it('csv and xlsx are accepted when listed (CR scanState addendum)', () => {
    const { onSelect, pick } = setup({ accept: ['text/csv', XLSX], multiple: true });
    pick([file('a.csv', 'text/csv'), file('b.xlsx', XLSX)]);
    expect(selectedFiles(onSelect).map((f) => f.name)).toEqual(['a.csv', 'b.xlsx']);
  });

  it('a type outside accept is rejected with a visible message and never reaches onSelect', () => {
    const { onSelect, pick } = setup();
    pick([file('page.html', 'text/html')]);
    expect(selectedFiles(onSelect)).toHaveLength(0);
    expect(screen.getByText(/not allowed|unsupported|type|format/i)).toBeTruthy();
  });

  it('the declared type decides, not the extension: "evil.pdf" typed text/html is rejected', () => {
    const { onSelect, pick } = setup();
    pick([file('evil.pdf', 'text/html')]);
    expect(selectedFiles(onSelect)).toHaveLength(0);
  });

  it('empty type (unknown) is rejected', () => {
    const { onSelect, pick } = setup();
    pick([file('mystery.pdf', '')]);
    expect(selectedFiles(onSelect)).toHaveLength(0);
  });

  it('size: default limit is 15 MB - exactly 15 MB passes, 15 MB + 1 byte is rejected with a message', () => {
    const { onSelect, pick } = setup();
    pick([file('ok.pdf', PDF, 15 * MB)]);
    expect(selectedFiles(onSelect).map((f) => f.name)).toEqual(['ok.pdf']);
    pick([file('big.pdf', PDF, 15 * MB + 1)]);
    expect(selectedFiles(onSelect).map((f) => f.name)).toEqual(['ok.pdf']);
    expect(screen.getByText(/too large|exceeds|larger|15 ?MB/i)).toBeTruthy();
  });

  it('maxBytes overrides the limit', () => {
    const { onSelect, pick } = setup({ maxBytes: 1000 });
    pick([file('a.pdf', PDF, 1001)]);
    expect(selectedFiles(onSelect)).toHaveLength(0);
    pick([file('b.pdf', PDF, 1000)]);
    expect(selectedFiles(onSelect).map((f) => f.name)).toEqual(['b.pdf']);
  });

  it('zero-byte files are rejected', () => {
    const { onSelect, pick } = setup();
    pick([file('empty.pdf', PDF, 0)]);
    expect(selectedFiles(onSelect)).toHaveLength(0);
  });

  it('one bad file in a batch does not smuggle the others past the checks, and good ones are still offered', () => {
    const { onSelect, pick } = setup({ multiple: true });
    pick([file('good.pdf', PDF), file('bad.html', 'text/html')]);
    expect(selectedFiles(onSelect).map((f) => f.name)).toEqual(['good.pdf']);
  });

  it('single mode (multiple not set): the input is not multiple and never passes more than one file', () => {
    const { onSelect, input, pick } = setup();
    expect(input().multiple).toBe(false);
    pick([file('a.pdf', PDF), file('b.pdf', PDF)]);
    for (const c of onSelect.mock.calls) expect((c[0] as File[]).length).toBeLessThanOrEqual(1);
  });

  it('multiple + maxFiles: never more than maxFiles in one selection, with a message', () => {
    const { onSelect, input, pick } = setup({ multiple: true, maxFiles: 2 });
    expect(input().multiple).toBe(true);
    pick([file('a.pdf', PDF), file('b.pdf', PDF), file('c.pdf', PDF)]);
    for (const c of onSelect.mock.calls) expect((c[0] as File[]).length).toBeLessThanOrEqual(2);
    expect(screen.getByText(/too many|at most|maximum|no more than/i)).toBeTruthy();
  });

  it('drag-and-drop goes through the same checks (FileDropzone maps here)', () => {
    const { onSelect, input } = setup();
    const ok = file('drop.pdf', PDF);
    fireEvent.drop(input(), { dataTransfer: { files: [ok], types: ['Files'] } });
    expect(selectedFiles(onSelect)).toEqual([ok]);
    fireEvent.drop(input(), { dataTransfer: { files: [file('x.exe', 'application/x-msdownload')], types: ['Files'] } });
    expect(selectedFiles(onSelect)).toEqual([ok]);
  });

  it('isDisabled: input disabled', () => {
    const { input } = setup({ isDisabled: true });
    expect(input().disabled).toBe(true);
  });

  it('error prop is text linked by aria-describedby', () => {
    const { input } = setup({ error: 'Attach the signed consent form' });
    const d = (input().getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(d).toContain('Attach the signed consent form');
  });
});

describe('FileUpload: progress and scan state (per file, keyed by file name)', () => {
  it('progress renders a progressbar with the percentage for that file', () => {
    const { pick, rerender } = setup();
    pick([file('report.pdf', PDF)]);
    expect(screen.getByText(/report\.pdf/)).toBeTruthy();
    rerender(<FileUpload label="Attachment" name="attachment" accept={[PDF]} onSelect={() => {}} progress={{ 'report.pdf': 40 }} />);
    const bar = screen.getByRole('progressbar');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(40);
    expect(bar.getAttribute('aria-label') ?? bar.textContent ?? '').toMatch(/report\.pdf/);
  });

  it.each([
    ['pending', /pending|scanning/i],
    ['clean', /clean/i],
    ['infected', /infected/i],
    ['unavailable', /unavailable/i],
  ] as const)('scanState %s is shown as text (not colour alone)', (state, re) => {
    const { pick, rerender } = setup();
    pick([file('report.pdf', PDF)]);
    rerender(<FileUpload label="Attachment" name="attachment" accept={[PDF]} onSelect={() => {}} scanState={{ 'report.pdf': state }} />);
    expect(screen.getByText(re)).toBeTruthy();
  });

  it('scan states of two files do not bleed into each other', () => {
    const { pick, rerender } = setup({ multiple: true });
    pick([file('a.pdf', PDF), file('b.pdf', PDF)]);
    rerender(<FileUpload label="Attachment" name="attachment" accept={[PDF]} multiple onSelect={() => {}} scanState={{ 'a.pdf': 'clean', 'b.pdf': 'infected' }} />);
    const a = screen.getByText(/a\.pdf/).closest('li') ?? screen.getByText(/a\.pdf/).parentElement!;
    const b = screen.getByText(/b\.pdf/).closest('li') ?? screen.getByText(/b\.pdf/).parentElement!;
    expect(a.textContent).toMatch(/clean/i);
    expect(a.textContent).not.toMatch(/infected/i);
    expect(b.textContent).toMatch(/infected/i);
  });

  it('an infected file is announced assertively (role=alert)', () => {
    const { pick, rerender } = setup();
    pick([file('report.pdf', PDF)]);
    rerender(<FileUpload label="Attachment" name="attachment" accept={[PDF]} onSelect={() => {}} scanState={{ 'report.pdf': 'infected' }} />);
    expect(within(screen.getByRole('alert')).getByText(/infected/i)).toBeTruthy();
  });
});

describe('FileUpload: never previews untrusted content (REQ-SEC-085) and renders names as text (REQ-SEC-088)', () => {
  it('selecting an image/png and a pdf creates no preview element and no object URL', () => {
    const create = vi.fn(() => 'blob:x');
    const orig = URL.createObjectURL;
    URL.createObjectURL = create as any;
    try {
      const { pick } = setup({ multiple: true });
      pick([file('scan.png', 'image/png'), file('doc.pdf', PDF)]);
      expect(create).not.toHaveBeenCalled();
      expect(document.querySelector('img,iframe,embed,object,video,audio,canvas,svg image')).toBeNull();
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('does not read file contents (no FileReader)', () => {
    const spy = vi.spyOn(globalThis, 'FileReader' as any);
    const { pick } = setup();
    pick([file('scan.png', 'image/png')]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(XSS)('file name is text: %s', (payload) => {
    const { pick } = setup({ accept: ['image/png'] });
    pick([file(`${payload}.png`, 'image/png')]);
    expect(document.querySelector('img[src=x],script,svg[onload]')).toBeNull();
    expect((window as any).__xss).toBeUndefined();
  });

  it('Devanagari file names are shown verbatim', () => {
    const { pick } = setup();
    pick([file(`${DEVANAGARI}.pdf`, PDF)]);
    expect(screen.getByText(new RegExp(DEVANAGARI.slice(0, 6)))).toBeTruthy();
  });
});

describe('FileUpload: axe (AC-0D-8.6)', () => {
  it('empty, with files + progress + scan state, with error', async () => {
    const a = setup({ error: 'Attach a file' });
    expect(await seriousViolations()).toEqual([]);
    a.unmount();
    const b = setup({ multiple: true, progress: { 'a.pdf': 50 }, scanState: { 'a.pdf': 'pending', 'b.pdf': 'clean' } });
    b.pick([file('a.pdf', PDF), file('b.pdf', PDF)]);
    expect(await seriousViolations()).toEqual([]);
  });
});
