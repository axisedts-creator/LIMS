// @vitest-environment jsdom
// T0D-12b (04-UI-UX §2.8, Phase-1 set): DiffTable, DataUriImage, StatusStepper, CodeBlock, SecretRevealOnce,
// ImageThumbnailGrid, PdfFileCard, DurationText, FreshnessBadge. Copy strings are quoted verbatim from the consumer chunks' 04-UI-UX.
// ASSUMED API (writer must match or raise CR):
//   DiffTable          { rows: {label,before,after,changed}[]; beforeLabel?; afterLabel?; maxValueLength? (default 200; longer values collapsed behind a toggle button) }
//   DataUriImage       { src: string; alt: string }   only data:image/png;base64,… or data:image/svg+xml;base64,…; anything else renders no <img>
//   StatusStepper      { steps: {id,label}[]; currentId: string; outcome?: {kind:'failed'|'cancelled'; label:string} }   <ol>, aria-current="step"
//   CodeBlock          { value: string; label: string; renderControlChars?: boolean; allowCopy?: boolean (default false); caption?: string }
//   SecretRevealOnce   { label: string; value: string; requireAcknowledgement?: boolean (default true); onDone: () => void }
//   ImageThumbnailGrid { label: string; images: {id, src, alt, caption?, state:'ready'|'processing'|'quarantined'}[]; onSelect?(id) }
//   PdfFileCard        { fileName; sizeBytes; pageCount?; state: 'pending_scan'|'scanning'|'sanitizing'|'ready'|'quarantined'|'rejected'|'confirmed';
//                        rejectReason?: 'encrypted'|'damaged'|'too_many_pages'|'timed_out'; confirmedBy?; confirmedAt? }   data-tone on the state chip
//   DurationText       { seconds: number }   focusable; role=tooltip with exact seconds (C8 04-UI-UX:51)
//   FreshnessBadge     { refreshedAt?: IsoUtc; isStale: boolean; reason?: 'refresh_lagging'|'refresh_failed'|'never_refreshed' }   data-tone, focusable tooltip (C8 :47)
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { DiffTable } from '../DiffTable/DiffTable';
import { DataUriImage } from '../DataUriImage/DataUriImage';
import { StatusStepper } from '../StatusStepper/StatusStepper';
import { CodeBlock } from '../CodeBlock/CodeBlock';
import { SecretRevealOnce } from '../SecretRevealOnce/SecretRevealOnce';
import { ImageThumbnailGrid } from '../ImageThumbnailGrid/ImageThumbnailGrid';
import { PdfFileCard } from '../PdfFileCard/PdfFileCard';
import { DurationText } from '../DurationText/DurationText';
import { FreshnessBadge } from '../FreshnessBadge/FreshnessBadge';
import { DEVANAGARI, XSS, seriousViolations, user } from './helpers';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';

describe('DiffTable (C2 AD-11, C3 compare)', () => {
  const rows = [
    { label: 'Name', before: 'Lab Tech', after: 'Lab Technician', changed: true },
    { label: 'Active', before: 'yes', after: 'yes', changed: false },
  ];
  it('is a table with label / old / new columns', () => {
    render(<DiffTable rows={rows} beforeLabel="Before" afterLabel="After" />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(expect.arrayContaining(['Before', 'After']));
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(3);
  });
  it('AC-0D-8.3 spirit: changed rows carry the text marker "changed" (not colour only); unchanged rows do not', () => {
    render(<DiffTable rows={rows} />);
    const [, nameRow, activeRow] = screen.getAllByRole('row');
    expect(within(nameRow).getByText(/changed/i)).toBeTruthy();
    expect(within(activeRow).queryByText(/changed/i)).toBeNull();
  });
  it('REQ-SEC-088: before/after/label are text nodes (XSS payloads inert)', () => {
    (window as any).__xss = 0;
    const { container } = render(<DiffTable rows={XSS.map((x) => ({ label: x, before: x, after: x + '!', changed: true }))} />);
    expect(container.querySelector('script, img, svg, a[href^="javascript"]')).toBeNull();
    expect(screen.getAllByText(XSS[0]).length).toBeGreaterThan(0);
    expect((window as any).__xss).toBe(0);
  });
  it('long values are collapsed behind a keyboard-operable toggle and the full text is available on expand', async () => {
    const long = 'x'.repeat(1000);
    render(<DiffTable rows={[{ label: 'Blob', before: long, after: long + 'y', changed: true }]} />);
    expect(screen.queryByText(long, { exact: true })).toBeNull();
    const toggle = screen.getAllByRole('button', { name: /show|expand|more/i })[0];
    toggle.focus();
    await user().keyboard('{Enter}');
    expect(document.body.textContent).toContain(long);
  });
  it('Devanagari values render intact', () => {
    render(<DiffTable rows={[{ label: 'Name', before: DEVANAGARI, after: DEVANAGARI + '१', changed: true }]} />);
    expect(screen.getByText(DEVANAGARI)).toBeTruthy();
  });
  it('axe clean', async () => {
    render(<DiffTable rows={rows} beforeLabel="Before" afterLabel="After" />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('DataUriImage (C2)', () => {
  it('renders PNG and base64 SVG data URIs as <img> with the alt text, byte-for-byte src', () => {
    const { container, rerender } = render(<DataUriImage src={PNG} alt="QR code for your authenticator app" />);
    const img = screen.getByRole('img', { name: 'QR code for your authenticator app' });
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(PNG);
    rerender(<DataUriImage src={SVG} alt="QR" />);
    expect(screen.getByRole('img', { name: 'QR' }).getAttribute('src')).toBe(SVG);
    expect(container.querySelector('svg')).toBeNull(); // never inline SVG markup
  });
  it.each([
    ['https remote', 'https://evil.example/x.png'],
    ['protocol-relative', '//evil.example/x.png'],
    ['javascript:', 'javascript:alert(1)'],
    ['html data uri', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['gif (png/svg only)', 'data:image/gif;base64,R0lGODlhAQABAAAAACw='],
    ['jpeg (png/svg only)', 'data:image/jpeg;base64,/9j/4AAQ'],
    ['svg not base64', 'data:image/svg+xml;utf8,<svg onload=alert(1)>'],
    ['base64 payload with markup', 'data:image/png;base64,<script>alert(1)</script>'],
    ['relative path', '/api/qr.png'],
    ['empty', ''],
  ])('rejects %s: no <img> is rendered and nothing throws', (_n, src) => {
    const { container } = render(<DataUriImage src={src} alt="x" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg, script, iframe, object, embed')).toBeNull();
  });
  it('alt is mandatory text (decorative empty alt not allowed by role query: img keeps a name)', () => {
    render(<DataUriImage src={PNG} alt="Scan me" />);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('Scan me');
  });
  it('axe clean', async () => {
    render(<DataUriImage src={PNG} alt="QR" />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('StatusStepper (C3)', () => {
  const steps = ['Uploaded', 'Security scan', 'Validating', 'Ready to commit', 'Committing', 'Committed'].map((label, i) => ({ id: `s${i}`, label }));
  it('is an ordered list of all steps, in order', () => {
    render(<StatusStepper steps={steps} currentId="s2" />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(expect.arrayContaining(steps.map((s) => expect.stringContaining(s.label))));
    expect(screen.getByRole('list').tagName).toBe('OL');
  });
  it('exactly one step has aria-current=step: the current one', () => {
    render(<StatusStepper steps={steps} currentId="s2" />);
    const cur = screen.getAllByRole('listitem').filter((i) => i.getAttribute('aria-current') === 'step');
    expect(cur).toHaveLength(1);
    expect(cur[0].textContent).toContain('Validating');
  });
  it('done / current / upcoming are conveyed by text, not colour (04 §5.4)', () => {
    render(<StatusStepper steps={steps} currentId="s2" />);
    const li = screen.getAllByRole('listitem');
    expect(li[0].textContent).toMatch(/complete|done/i);
    expect(li[2].textContent).toMatch(/current|in progress/i);
    expect(li[4].textContent).toMatch(/upcoming|pending|not started/i);
  });
  it('terminal failed/cancelled outcome shows its label as text and is announced', () => {
    render(<StatusStepper steps={steps} currentId="s1" outcome={{ kind: 'failed', label: 'Security scan found a problem' }} />);
    expect(screen.getByText('Security scan found a problem')).toBeTruthy();
    expect(document.querySelector('[role="alert"], [role="status"], [aria-live]')).toBeTruthy();
  });
  it('unknown currentId does not throw and marks no step current', () => {
    render(<StatusStepper steps={steps} currentId="nope" />);
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });
  it('axe clean', async () => {
    render(<StatusStepper steps={steps} currentId="s3" />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('CodeBlock (C7)', () => {
  it('is a focusable region named by `label`, content shown verbatim as text', async () => {
    render(<CodeBlock label="Raw message" value={'MSH|^~\\&|LAB\rPID|1'} />);
    const region = screen.getByRole('region', { name: 'Raw message' });
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toContain('MSH|^~\\&|LAB');
    await user().tab();
    expect(document.activeElement).toBe(region);
  });
  it('renderControlChars shows control characters as text badges like <STX>, not bare control codes', () => {
    render(<CodeBlock label="Raw message" value={'\x02H|\\^&\x03'} renderControlChars />);
    const region = screen.getByRole('region', { name: 'Raw message' });
    expect(region.textContent).toContain('<STX>');
    expect(region.textContent).toContain('<ETX>');
    expect(region.textContent).not.toMatch(/[\x00-\x08\x0e-\x1f]/);
  });
  it('allowCopy=false: no copy button, and copy/cut events from the block are cancelled', () => {
    render(<CodeBlock label="Raw message" value="secret-ish" allowCopy={false} />);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    const region = screen.getByRole('region', { name: 'Raw message' });
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    region.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
  it('default (allowCopy omitted) shows no Copy button — default false for PHI (C7 02-TRD:1093)', () => {
    render(<CodeBlock label="Raw message" value="x" />);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });
  it('allowCopy shows a Copy button that writes the exact value to the clipboard', async () => {
    render(<CodeBlock label="Agent log" value={'line1\nline2'} allowCopy />);
    await user().click(screen.getByRole('button', { name: /copy/i }));
    expect(await navigator.clipboard.readText()).toBe('line1\nline2');
  });
  it('REQ-SEC-088: markup in the value is text', () => {
    (window as any).__xss = 0;
    const { container } = render(<CodeBlock label="Raw message" value={XSS.join('\n')} />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('caption is rendered as text; axe clean', async () => {
    render(<CodeBlock label="Raw message" value="x" caption="Viewing raw messages is recorded." />);
    expect(screen.getByText('Viewing raw messages is recorded.')).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('SecretRevealOnce (C2 + C7)', () => {
  const SECRET = 'ENROL-7K2Q-ZZ81-SYNTH';
  it('shows the secret in read-only monospace text with a hint that it is shown once, and announces it', () => {
    render(<SecretRevealOnce label="Enrolment code" value={SECRET} onDone={() => {}} />);
    expect(document.body.textContent).toContain(SECRET);
    expect(screen.getByText(/shown once|only once|once/i)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Code shown\. Copy it now\./);
    for (const t of screen.queryAllByRole('textbox') as HTMLInputElement[]) expect(t.readOnly).toBe(true);
  });
  it('Copy writes the exact secret to the clipboard', async () => {
    render(<SecretRevealOnce label="Enrolment code" value={SECRET} onDone={() => {}} />);
    await user().click(screen.getByRole('button', { name: /copy/i }));
    expect(await navigator.clipboard.readText()).toBe(SECRET);
  });
  it('requireAcknowledgement defaults to true: Done is disabled until the acknowledgement checkbox is ticked', async () => {
    const onDone = vi.fn();
    render(<SecretRevealOnce label="Enrolment code" value={SECRET} onDone={onDone} />);
    const done = screen.getByRole('button', { name: /done|close|continue/i }) as HTMLButtonElement;
    expect(done.disabled || done.getAttribute('aria-disabled') === 'true').toBe(true);
    const u = user();
    await u.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: /done|close|continue/i }) as HTMLButtonElement).disabled).toBe(false);
    await u.click(screen.getByRole('button', { name: /done|close|continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it('requireAcknowledgement={false}: no checkbox and Done is enabled at once', () => {
    render(<SecretRevealOnce label="Setup key" value={SECRET} requireAcknowledgement={false} onDone={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: /done|close|continue/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('after Done the secret is gone from the DOM and never re-rendered (even if the parent keeps passing it)', async () => {
    const { rerender, container } = render(<SecretRevealOnce label="Setup key" value={SECRET} requireAcknowledgement={false} onDone={() => {}} />);
    await user().click(screen.getByRole('button', { name: /done|close|continue/i }));
    expect(document.body.textContent).not.toContain(SECRET);
    rerender(<SecretRevealOnce label="Setup key" value={SECRET} requireAcknowledgement={false} onDone={() => {}} />);
    expect(container.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });
  it('the secret is not placed in any attribute that survives (title, data-*, aria-label)', () => {
    const { container } = render(<SecretRevealOnce label="Enrolment code" value={SECRET} onDone={() => {}} />);
    const withSecretAttr = Array.from(container.querySelectorAll('*')).filter((e) =>
      Array.from(e.attributes).some((a) => a.value.includes(SECRET) && !['value'].includes(a.name)));
    expect(withSecretAttr).toEqual([]);
  });
  it('axe clean', async () => {
    render(<SecretRevealOnce label="Enrolment code" value={SECRET} onDone={() => {}} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('ImageThumbnailGrid (C6, C11)', () => {
  const images = [
    { id: 'a', src: '/bff/images/a/content', alt: 'Gross image 1', caption: 'Margin', state: 'ready' as const },
    { id: 'b', src: '/bff/images/b/content', alt: 'Gross image 2', state: 'processing' as const },
    { id: 'c', src: '/bff/images/c/content', alt: 'Gross image 3', state: 'quarantined' as const },
  ];
  it('is a named list; only READY images get an <img> (non-ready are never requested)', () => {
    const { container } = render(<ImageThumbnailGrid label="Case images" images={images} />);
    expect(screen.getByRole('list', { name: 'Case images' })).toBeTruthy();
    const imgs = Array.from(container.querySelectorAll('img'));
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/bff/images/a/content']);
    expect(imgs[0].getAttribute('alt')).toBe('Gross image 1');
  });
  it('states are text chips: "Processing…" and "Blocked by security scan" (never colour only)', () => {
    render(<ImageThumbnailGrid label="Case images" images={images} />);
    expect(screen.getByText('Processing…')).toBeTruthy();
    expect(screen.getByText('Blocked by security scan')).toBeTruthy();
    expect(screen.getByText('Blocked by security scan').closest('[data-tone]')?.getAttribute('data-tone')).toBe('danger');
  });
  it('REQ-SEC-141: a ready image whose src leaves the origin is not rendered', () => {
    const { container } = render(<ImageThumbnailGrid label="Case images" images={[
      { id: 'x', src: 'https://evil.example/p.png', alt: 'x', state: 'ready' },
      { id: 'y', src: '//evil.example/p.png', alt: 'y', state: 'ready' },
      { id: 'z', src: 'javascript:alert(1)', alt: 'z', state: 'ready' },
    ]} />);
    expect(container.querySelector('img')).toBeNull();
  });
  it('captions and alts are text (XSS); caption is not an attribute injection vector', () => {
    (window as any).__xss = 0;
    const { container } = render(<ImageThumbnailGrid label="Case images" images={[{ id: 'a', src: '/i/a', alt: XSS[0], caption: XSS[1], state: 'ready' }]} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('img')!.getAttribute('onerror')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('onSelect fires from keyboard (Enter) on a ready image; non-ready images are not selectable', async () => {
    const onSelect = vi.fn();
    render(<ImageThumbnailGrid label="Case images" images={images} onSelect={onSelect} />);
    const u = user();
    await u.tab();
    await u.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('a');
    onSelect.mockClear();
    for (let i = 0; i < 6; i++) await u.tab();
    await u.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalledWith('b');
    expect(onSelect).not.toHaveBeenCalledWith('c');
  });
  it('empty list renders without error', () => {
    render(<ImageThumbnailGrid label="Case images" images={[]} />);
    expect(screen.getByRole('list', { name: 'Case images' })).toBeTruthy();
  });
  it('axe clean', async () => {
    render(<ImageThumbnailGrid label="Case images" images={images} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('PdfFileCard (C6) — state copy is verbatim from C6 04-UI-UX:115-122', () => {
  const base = { fileName: 'scan-001.pdf', sizeBytes: 1_048_576, pageCount: 3 };
  it('shows filename, size and pages as text', () => {
    render(<PdfFileCard {...base} state="ready" />);
    expect(screen.getByText('scan-001.pdf')).toBeTruthy();
    expect(document.body.textContent).toMatch(/1(\.0)?\s?MB|1,048,576|1024\s?KB/i);
    expect(document.body.textContent).toMatch(/3\s*(pages|page|p)\b/i);
  });
  it.each([
    ['pending_scan', 'Checking the file for viruses…'],
    ['scanning', 'Checking the file for viruses…'],
    ['sanitizing', 'Preparing the file…'],
    ['ready', 'Ready. Open it and confirm it belongs to this patient.'],
    ['quarantined', 'This file was blocked by the virus scanner and has been isolated.'],
  ] as const)('state %s -> "%s"', (state, copy) => {
    render(<PdfFileCard {...base} state={state} />);
    expect(screen.getByText(copy)).toBeTruthy();
  });
  it('rejected -> "This PDF could not be used ({reason}…)." with the reason as text', () => {
    render(<PdfFileCard {...base} state="rejected" rejectReason="encrypted" />);
    expect(document.body.textContent).toMatch(/This PDF could not be used/);
    expect(document.body.textContent).toMatch(/encrypted/);
  });
  it('confirmed -> "Confirmed by {user} at {time}."', () => {
    render(<PdfFileCard {...base} state="confirmed" confirmedBy="Asha Test" confirmedAt="2026-11-06T04:15:00Z" />);
    expect(document.body.textContent).toMatch(/Confirmed by Asha Test at /);
  });
  it('quarantined chip is danger-toned and still text', () => {
    render(<PdfFileCard {...base} state="quarantined" />);
    expect(document.querySelector('[data-tone="danger"]')).toBeTruthy();
  });
  it('a quarantined or rejected file offers no way to open it', () => {
    render(<PdfFileCard {...base} state="quarantined" />);
    expect(document.querySelector('a[href]')).toBeNull();
    expect(screen.queryByRole('button', { name: /open|view|download/i })).toBeNull();
  });
  it('REQ-SEC-088: filename and user are text (XSS)', () => {
    (window as any).__xss = 0;
    const { container } = render(<PdfFileCard {...base} fileName={XSS[0]} state="confirmed" confirmedBy={XSS[1]} confirmedAt="2026-11-06T04:15:00Z" />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('axe clean', async () => {
    render(<PdfFileCard {...base} state="ready" />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('DurationText (C8) — C8 04-UI-UX:51', () => {
  it.each([
    [0, '0 min'],
    [42 * 60, '42 min'],
    [59 * 60 + 59, '59 min'],
    [3660, '1 h 1 min'],
    [5 * 3600 + 12 * 60, '5 h 12 min'],
    [47 * 3600 + 59 * 60, '47 h 59 min'],
    [49 * 3600, '2 d 1 h'],
    [3 * 86400 + 4 * 3600, '3 d 4 h'],
  ])('%i s -> "%s"', (s, text) => {
    render(<DurationText seconds={s} />);
    expect(screen.getByText(text)).toBeTruthy();
  });
  it('focus opens a tooltip with the exact seconds', async () => {
    render(<DurationText seconds={18720} />);
    await user().tab();
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/18[,.\s]?720/));
  });
  it.each([[Number.NaN], [-5], [Number.POSITIVE_INFINITY]])('bad input %s never renders NaN/Infinity/negative and does not throw', (s) => {
    const { container } = render(<DurationText seconds={s as number} />);
    expect(container.textContent).not.toMatch(/NaN|Infinity|-\d/);
  });
  it('axe clean', async () => {
    render(<DurationText seconds={3000} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('FreshnessBadge (C8) — C8 04-UI-UX:47', () => {
  it('fresh: "Updated {time}" and a non-warning tone', () => {
    render(<FreshnessBadge refreshedAt="2026-11-06T04:15:00Z" isStale={false} />);
    const t = screen.getByText(/^Updated /);
    expect(t.closest('[data-tone]')?.getAttribute('data-tone')).not.toBe('warning');
  });
  it('stale: warning tone and the text "Data may be out of date" (not colour only)', () => {
    render(<FreshnessBadge refreshedAt="2026-11-06T04:15:00Z" isStale reason="refresh_lagging" />);
    const t = screen.getByText('Data may be out of date');
    expect(t.closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
  });
  it.each([
    ['refresh_lagging', 'Recent changes are still being processed'],
    ['refresh_failed', 'Last update failed — the team has been alerted'],
    ['never_refreshed', 'Not yet calculated'],
  ] as const)('stale reason %s -> tooltip "%s", reachable by keyboard focus', async (reason, copy) => {
    render(<FreshnessBadge refreshedAt={reason === 'never_refreshed' ? undefined : '2026-11-06T04:15:00Z'} isStale reason={reason} />);
    await user().tab();
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(copy));
  });
  it('axe clean', async () => {
    render(<FreshnessBadge refreshedAt="2026-11-06T04:15:00Z" isStale reason="refresh_failed" />);
    expect(await seriousViolations()).toEqual([]);
  });
});
