// @vitest-environment jsdom
// T0D-12b (04-UI-UX §2.8, Phase-1 set): DiffTable, DataUriImage, StatusStepper, CodeBlock, SecretRevealOnce,
// ImageThumbnailGrid, PdfFileCard, DurationText, FreshnessBadge. Copy strings are quoted verbatim from the consumer chunks' 04-UI-UX.
// ASSUMED API (writer must match or raise CR):
//   DiffTable          { rows: {label,before,after,changed}[]; beforeLabel?; afterLabel?; maxValueLength? (default 200; longer values collapsed behind a toggle button) }
//   DataUriImage       { src: string; alt: string }   only data:image/png;base64,… or data:image/svg+xml;base64,…; anything else renders no <img>
//   StatusStepper      { steps: {id,label}[]; currentId: string; outcome?: {kind:'failed'|'cancelled'; label:string} }   <ol>, aria-current="step"
//   CodeBlock          { label: string; text: string; renderControlChars?: boolean; maxHeight?: number; wrap?: boolean; allowCopy?: boolean (default false) }   (C7 02-TRD:1093)
//   SecretRevealOnce   { label: string; secret: string; expiresAt?: IsoUtc; requireAcknowledgement?: boolean (default true); onAcknowledged: () => void }   (C7 02-TRD:1094; C0 §2.8)
//   ImageThumbnailGrid { items: {id, src (BFF URL), caption?, state:'scanning'|'ready'|'rejected'}[]; onCaptionChange?(id,caption); onRemove?(id); onReorder?(ids);
//                        captionMaxLength: number; max: number }   (C6 04-UI-UX:323-324). Reorder UI (not spec'd): per-item buttons named /move … earlier|up|left/ and /move … later|down|right/, in item order.
//   PdfFileCard        { filename; sizeBytes; pageCount?; state: string; stateLabel: string; tone: Tone; onDownload?() }   (C6 04-UI-UX:325) chip text = stateLabel, data-tone = tone
//   DurationText       { seconds: number; style: 'short'|'long' }   focusable; role=tooltip with exact seconds (C8 04-UI-UX:51; C8 02-TRD:1094)
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
    render(<CodeBlock label="Raw message" text={'MSH|^~\\&|LAB\rPID|1'} />);
    const region = screen.getByRole('region', { name: 'Raw message' });
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toContain('MSH|^~\\&|LAB');
    await user().tab();
    expect(document.activeElement).toBe(region);
  });
  it('renderControlChars shows control characters as text badges like <STX>, not bare control codes', () => {
    render(<CodeBlock label="Raw message" text={'\x02H|\\^&\x03'} renderControlChars />);
    const region = screen.getByRole('region', { name: 'Raw message' });
    expect(region.textContent).toContain('<STX>');
    expect(region.textContent).toContain('<ETX>');
    expect(region.textContent).not.toMatch(/[\x00-\x08\x0e-\x1f]/);
  });
  it('allowCopy=false: no copy button, and copy/cut events from the block are cancelled', () => {
    render(<CodeBlock label="Raw message" text="secret-ish" allowCopy={false} />);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    const region = screen.getByRole('region', { name: 'Raw message' });
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    region.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
  it('default (allowCopy omitted) shows no Copy button — default false for PHI (C7 02-TRD:1093)', () => {
    render(<CodeBlock label="Raw message" text="x" />);
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });
  it('allowCopy shows a Copy button that writes the exact text to the clipboard', async () => {
    render(<CodeBlock label="Agent log" text={'line1\nline2'} allowCopy />);
    await user().click(screen.getByRole('button', { name: /copy/i }));
    expect(await navigator.clipboard.readText()).toBe('line1\nline2');
  });
  it('REQ-SEC-088: markup in the value is text', () => {
    (window as any).__xss = 0;
    const { container } = render(<CodeBlock label="Raw message" text={XSS.join('\n')} />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('maxHeight caps the scrolling region; wrap toggles pre-wrap vs pre', () => {
    const { rerender } = render(<CodeBlock label="Raw message" text="x" maxHeight={120} />);
    const region = () => screen.getByRole('region', { name: 'Raw message' });
    expect(region().style.maxHeight).toBe('120px');
    const ws = () => getComputedStyle(region().querySelector('pre, code') ?? region()).whiteSpace;
    expect(ws()).not.toBe('pre-wrap');
    rerender(<CodeBlock label="Raw message" text="x" maxHeight={120} wrap />);
    expect(ws()).toBe('pre-wrap');
  });
  it('axe clean', async () => {
    render(<CodeBlock label="Raw message" text="x" />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('SecretRevealOnce (C2 + C7)', () => {
  const SECRET = 'ENROL-7K2Q-ZZ81-SYNTH';
  it('shows the secret in read-only monospace text with a hint that it is shown once, and announces it', () => {
    render(<SecretRevealOnce label="Enrolment code" secret={SECRET} onAcknowledged={() => {}} />);
    expect(document.body.textContent).toContain(SECRET);
    expect(screen.getByText(/shown once|only once|once/i)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Code shown\. Copy it now\./);
    for (const t of screen.queryAllByRole('textbox') as HTMLInputElement[]) expect(t.readOnly).toBe(true);
  });
  it('Copy writes the exact secret to the clipboard', async () => {
    render(<SecretRevealOnce label="Enrolment code" secret={SECRET} onAcknowledged={() => {}} />);
    await user().click(screen.getByRole('button', { name: /copy/i }));
    expect(await navigator.clipboard.readText()).toBe(SECRET);
  });
  it('requireAcknowledgement defaults to true: Done is disabled until the acknowledgement checkbox is ticked', async () => {
    const onDone = vi.fn();
    render(<SecretRevealOnce label="Enrolment code" secret={SECRET} onAcknowledged={onDone} />);
    const done = screen.getByRole('button', { name: /done|close|continue/i }) as HTMLButtonElement;
    expect(done.disabled || done.getAttribute('aria-disabled') === 'true').toBe(true);
    const u = user();
    expect(screen.getByRole('checkbox', { name: 'I have copied this code' })).toBeTruthy(); // exact copy, C7 _cr-extract:850
    await u.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: /done|close|continue/i }) as HTMLButtonElement).disabled).toBe(false);
    await u.click(screen.getByRole('button', { name: /done|close|continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it('requireAcknowledgement={false}: no checkbox and Done is enabled at once', () => {
    render(<SecretRevealOnce label="Setup key" secret={SECRET} requireAcknowledgement={false} onAcknowledged={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: /done|close|continue/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('after Done the secret is gone from the DOM and never re-rendered (even if the parent keeps passing it)', async () => {
    const { rerender, container } = render(<SecretRevealOnce label="Setup key" secret={SECRET} requireAcknowledgement={false} onAcknowledged={() => {}} />);
    await user().click(screen.getByRole('button', { name: /done|close|continue/i }));
    expect(document.body.textContent).not.toContain(SECRET);
    rerender(<SecretRevealOnce label="Setup key" secret={SECRET} requireAcknowledgement={false} onAcknowledged={() => {}} />);
    expect(container.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });
  it('the secret is not placed in any attribute that survives (title, data-*, aria-label)', () => {
    const { container } = render(<SecretRevealOnce label="Enrolment code" secret={SECRET} onAcknowledged={() => {}} />);
    const withSecretAttr = Array.from(container.querySelectorAll('*')).filter((e) =>
      Array.from(e.attributes).some((a) => a.value.includes(SECRET) && !['value'].includes(a.name)));
    expect(withSecretAttr).toEqual([]);
  });
  it('expiresAt, when given, is shown as text', () => {
    render(<SecretRevealOnce label="Enrolment code" secret={SECRET} expiresAt="2026-11-06T04:15:00Z" onAcknowledged={() => {}} />);
    expect(document.body.textContent).toMatch(/expire/i);
    expect(document.body.textContent).toMatch(/2026|Nov/);
  });
  it('axe clean', async () => {
    render(<SecretRevealOnce label="Enrolment code" secret={SECRET} onAcknowledged={() => {}} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('ImageThumbnailGrid (C6, C11)', () => {
  const items = [
    { id: 'a', src: '/bff/images/a/content', caption: 'Margin', state: 'ready' as const },
    { id: 'b', src: '/bff/images/b/content', caption: 'Cut surface', state: 'scanning' as const },
    { id: 'c', src: '/bff/images/c/content', state: 'rejected' as const },
  ];
  const base = { captionMaxLength: 200, max: 12 };
  it('is a list of all items; only READY images get an <img> (scanning/rejected are never requested)', () => {
    const { container } = render(<ImageThumbnailGrid items={items} {...base} />);
    expect(screen.getByRole('list')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'))).toEqual(['/bff/images/a/content']);
  });
  it('non-ready states are text chips with a tone (never colour only); rejected is danger', () => {
    const { container } = render(<ImageThumbnailGrid items={items} {...base} />);
    const chips = Array.from(container.querySelectorAll('[data-tone]'));
    expect(chips).toHaveLength(2); // scanning + rejected only
    for (const c of chips) expect((c.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(chips.some((c) => c.getAttribute('data-tone') === 'danger')).toBe(true);
  });
  it('REQ-SEC-141: a ready image whose src leaves the origin is not rendered', () => {
    const { container } = render(<ImageThumbnailGrid {...base} items={[
      { id: 'x', src: 'https://evil.example/p.png', state: 'ready' },
      { id: 'y', src: '//evil.example/p.png', state: 'ready' },
      { id: 'z', src: 'javascript:alert(1)', state: 'ready' },
    ]} />);
    expect(container.querySelector('img')).toBeNull();
  });
  it('without onCaptionChange the caption is read-only text; XSS payload is inert', () => {
    (window as any).__xss = 0;
    const { container } = render(<ImageThumbnailGrid {...base} items={[{ id: 'a', src: '/i/a', caption: XSS[1], state: 'ready' }]} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')!.getAttribute('onerror')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('with onCaptionChange each caption is a labelled textbox capped by captionMaxLength; typing reports (id, caption)', async () => {
    const onCaptionChange = vi.fn();
    render(<ImageThumbnailGrid items={items} {...base} captionMaxLength={40} onCaptionChange={onCaptionChange} />);
    const boxes = screen.getAllByRole('textbox', { name: /caption/i }) as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    expect(boxes[0].value).toBe('Margin');
    expect(boxes[0].getAttribute('maxlength')).toBe('40');
    await user().type(boxes[0], '!');
    expect(onCaptionChange).toHaveBeenLastCalledWith('a', 'Margin!');
  });
  it('caption value is XSS-inert when editable', () => {
    (window as any).__xss = 0;
    const { container } = render(<ImageThumbnailGrid {...base} onCaptionChange={() => {}} items={[{ id: 'a', src: '/i/a', caption: XSS[1], state: 'ready' }]} />);
    expect(container.querySelector('script, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('Remove: a distinguishable button per item; keyboard Enter calls onRemove(id)', async () => {
    const onRemove = vi.fn();
    render(<ImageThumbnailGrid items={items} {...base} onRemove={onRemove} />);
    const rm = screen.getAllByRole('button', { name: /remove/i });
    expect(rm).toHaveLength(3);
    expect(new Set(rm.map((b) => b.getAttribute('aria-label') ?? b.textContent)).size).toBe(3);
    rm[1].focus();
    await user().keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledWith('b');
  });
  it('no Remove / Move buttons or caption boxes when the callbacks are absent', () => {
    render(<ImageThumbnailGrid items={items} {...base} />);
    expect(screen.queryByRole('button', { name: /remove|move/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('Reorder is keyboard-operable: earlier/later buttons call onReorder with the full new id order', async () => {
    const onReorder = vi.fn();
    render(<ImageThumbnailGrid items={items} {...base} onReorder={onReorder} />);
    const earlier = screen.getAllByRole('button', { name: /move.*(earlier|up|left)/i }) as HTMLButtonElement[];
    const later = screen.getAllByRole('button', { name: /move.*(later|down|right)/i }) as HTMLButtonElement[];
    expect(earlier).toHaveLength(3);
    expect(later).toHaveLength(3);
    expect(earlier[0].disabled).toBe(true); // first cannot go earlier
    expect(later[2].disabled).toBe(true); // last cannot go later
    later[0].focus();
    await user().keyboard('{Enter}');
    expect(onReorder).toHaveBeenLastCalledWith(['b', 'a', 'c']);
    earlier[2].focus();
    await user().keyboard(' ');
    expect(onReorder).toHaveBeenLastCalledWith(['a', 'c', 'b']);
  });
  it('empty list renders without error', () => {
    render(<ImageThumbnailGrid items={[]} {...base} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
  it('axe clean (read-only and with all editing controls)', async () => {
    const { unmount } = render(<ImageThumbnailGrid items={items} {...base} />);
    expect(await seriousViolations()).toEqual([]);
    unmount();
    render(<ImageThumbnailGrid items={items} {...base} onCaptionChange={() => {}} onRemove={() => {}} onReorder={() => {}} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('PdfFileCard (C6) — C6 04-UI-UX:325; state text and tone come from the caller (copy per :115-121 is the caller\'s)', () => {
  const base = { filename: 'scan-001.pdf', sizeBytes: 1_048_576, pageCount: 3 };
  it('shows filename, size and pages as text', () => {
    render(<PdfFileCard {...base} state="ready" stateLabel="Ready." tone="success" />);
    expect(screen.getByText('scan-001.pdf')).toBeTruthy();
    expect(document.body.textContent).toMatch(/1(\.0)?\s?MB|1,048,576|1024\s?KB/i);
    expect(document.body.textContent).toMatch(/3\s*(pages|page|p)\b/i);
  });
  it('pageCount is optional: no page text when omitted', () => {
    render(<PdfFileCard filename="a.pdf" sizeBytes={2048} state="ready" stateLabel="Ready." tone="success" />);
    expect(document.body.textContent).not.toMatch(/\bpages?\b/i);
  });
  it.each([
    ['scanning', 'Checking the file for viruses…', 'info'],
    ['sanitizing', 'Preparing the file…', 'info'],
    ['ready', 'Ready. Open it and confirm it belongs to this patient.', 'success'],
    ['quarantined', 'This file was blocked by the virus scanner and has been isolated.', 'danger'],
    ['rejected', 'This PDF could not be used (encrypted).', 'danger'],
    ['confirmed', 'Confirmed by Asha Test at 2026-11-06 09:45.', 'success'],
  ] as const)('state %s: the caller\'s stateLabel is shown as text in a chip with data-tone=%s', (state, stateLabel, tone) => {
    render(<PdfFileCard {...base} state={state} stateLabel={stateLabel} tone={tone} />);
    const t = screen.getByText(stateLabel);
    expect(t.closest('[data-tone]')?.getAttribute('data-tone')).toBe(tone);
  });
  it('the card has no built-in state copy: an arbitrary state/stateLabel renders verbatim and nothing else', () => {
    render(<PdfFileCard {...base} state="custom_x" stateLabel="Zork" tone="neutral" />);
    expect(screen.getByText('Zork')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/viruses|Preparing|Confirmed by|could not be used/);
  });
  it('no onDownload: no way to open it (no link, no Download button)', () => {
    render(<PdfFileCard {...base} state="quarantined" stateLabel="Blocked." tone="danger" />);
    expect(document.querySelector('a[href]')).toBeNull();
    expect(screen.queryByRole('button', { name: /open|view|download/i })).toBeNull();
  });
  it('onDownload renders a Download button, operable by keyboard, calling the handler once', async () => {
    const onDownload = vi.fn();
    render(<PdfFileCard {...base} state="ready" stateLabel="Ready." tone="success" onDownload={onDownload} />);
    const b = screen.getByRole('button', { name: /download/i });
    b.focus();
    await user().keyboard('{Enter}');
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[href]')).toBeNull();
  });
  it('REQ-SEC-088: filename and stateLabel are text (XSS)', () => {
    (window as any).__xss = 0;
    const { container } = render(<PdfFileCard {...base} filename={XSS[0]} state="x" stateLabel={XSS[1]} tone="neutral" />);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect((window as any).__xss).toBe(0);
  });
  it('axe clean', async () => {
    render(<PdfFileCard {...base} state="ready" stateLabel="Ready." tone="success" onDownload={() => {}} />);
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
  ])('style=short: %i s -> "%s"', (s, text) => {
    render(<DurationText seconds={s} style="short" />);
    expect(screen.getByText(text)).toBeTruthy();
  });
  it.each([
    [42 * 60, /^42 minutes$/],
    [60, /^1 minute$/],
    [3660, /^1 hour,? (and )?1 minute$/],
    [5 * 3600 + 12 * 60, /^5 hours,? (and )?12 minutes$/],
    [3 * 86400 + 4 * 3600, /^3 days,? (and )?4 hours$/],
  ])('style=long: %i s is in full words, matching %s (marked [CONV]; same thresholds as short)', (s, re) => {
    const { container } = render(<DurationText seconds={s} style="long" />);
    expect((container.textContent ?? '').trim()).toMatch(re);
    expect(container.textContent).not.toMatch(/\b(min|h|d)\b/);
  });
  it('style changes the visible text but not the tooltip (exact seconds in both)', async () => {
    const { unmount } = render(<DurationText seconds={18720} style="long" />);
    await user().tab();
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/18[,.\s]?720/));
    unmount();
  });
  it('focus opens a tooltip with the exact seconds', async () => {
    render(<DurationText seconds={18720} style="short" />);
    await user().tab();
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toMatch(/18[,.\s]?720/));
  });
  it.each([['short'], ['long']] as const)('style=%s: bad input NaN / -5 / Infinity never renders NaN/Infinity/negative and does not throw', (style) => {
    for (const s of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const { container, unmount } = render(<DurationText seconds={s} style={style} />);
      expect(container.textContent).not.toMatch(/NaN|Infinity|-\d/);
      unmount();
    }
  });
  it.each([['short'], ['long']] as const)('axe clean (%s)', async (style) => {
    render(<DurationText seconds={3000} style={style} />);
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
