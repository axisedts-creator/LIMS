// C14-T22 — smart section renderer (services/renderer/templates/smart/). Spec: C14 04-UI-UX §4 (contract, layout, fixed copy), 02-TRD §5.3/§7 (Renderer row),
//   01-PRD AC-09.5, AC-12.4, AC-16.1–16.3, AC-18.1; C6 02-TRD §5.3 (SmartSectionRenderer, "same sanitiser profile"); 07-SECURITY T8.
// ASSUMED (spec names no more): `templates/smart/index.ts` exports `smartSectionRenderer` (04-UI-UX §4.1); `smart_render_not_approved` is logged through console.* or
//   process.stdout/stderr (the renderer has no logger module; any of them is accepted); text nodes may be entity-encoded in any way a browser decodes identically;
//   separators between tile name/status, finding direction/severity/text and trend cells are free (tests compare decoded visible text with tag boundaries = spaces).
// Snapshots (toMatchSnapshot) are written on the first green run by the implementer and must then be reviewed; before that every test fails on the missing module.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { smartSectionRenderer } from '../index.js';
import { loadRegistry } from '../../../src/templates/registry.js';
import { labReportTemplate } from '../../../src/templates/lab/index.js';
import { sanitizeHtml } from '../../../src/templates/narrative/sanitize.js';
import { makeAssets, makeConfig, makeDoc } from '../../../src/templates/__tests__/fixtures.js';
import { formatAd, formatBs, instantToBs, type IsoUtc } from '../../../../../packages/shared-ts/src/bsdate/index.js';
import { APPROVED_AT, DISCLAIMER_EN, HOSTILE, NOTICE, U, approved, decode, devanagari, emptyFindings, noScore, noTrends, tags, textOf } from './fixtures.js';

const TZ = 'Asia/Kathmandu';
const render = (summary: unknown, calendarDisplay = 'AD', timezone = TZ) => smartSectionRenderer.renderSections({ summary, calendarDisplay, timezone });
const pos = (text: string, ...needles: string[]) => needles.map((n) => { const i = text.indexOf(n); expect(i, `missing "${n}"`).toBeGreaterThanOrEqual(0); return i; });
const ascending = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1]! < v);
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const liWith = (html: string, needle: string) => new RegExp(`<li\\b[^>]*>((?:(?!</li>)[\\s\\S])*${needle}(?:(?!</li>)[\\s\\S])*)</li>`).exec(html)?.[1];

const ALLOWED_TAGS = new Set(['section', 'div', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'strong']);
const ALLOWED_ATTRS = new Set(['class', 'lang', 'aria-label', 'scope']);
const printCss = readFileSync(fileURLToPath(new URL('../../../src/templates/print.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const CSS_CLASSES = new Set([...printCss.matchAll(/\.(smart-[\w-]+)/g)].map((m) => m[1]!));

const FIXTURES: Record<string, () => any> = { approved, devanagari, 'no score': noScore, 'no trends': noTrends, 'empty findings': emptyFindings };

afterEach(() => { vi.restoreAllMocks(); });

describe('module contract (04-UI-UX §4.1; C6 registry loads it)', () => {
  it('exports smartSectionRenderer with libraryVersion smart-section-1 and renderSections()', () => {
    expect(smartSectionRenderer.libraryVersion).toBe('smart-section-1');
    expect(typeof smartSectionRenderer.renderSections).toBe('function');
  });
  it('loadRegistry() on the default templates root finds it (registry.smart)', async () => {
    expect((await loadRegistry()).smart?.libraryVersion).toBe('smart-section-1');
  });
  it('directory carries index.ts and no dangerouslySetInnerHTML / innerHTML in its sources', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    expect(existsSync(`${dir}index.ts`)).toBe(true);
    for (const f of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) expect(readFileSync(`${dir}${f}`, 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe('AC-16.1 — order, shape and allowed markup of the fragment', () => {
  it('one <section class="smart-section"> fragment; blocks in order: title, notice, score, tiles, deranged, trends, advice, follow-ups, disclaimer, meta', () => {
    const html = render(approved());
    expect(html.startsWith('<section class="smart-section"')).toBe(true);
    expect(html.trimEnd().endsWith('</section>')).toBe(true);
    expect(tags(html).filter((t) => t.name === 'section' && !t.close)).toHaveLength(1);
    const t = textOf(html);
    expect(ascending(pos(t, 'Smart summary', NOTICE, 'Health score (not a diagnosis)', 'SYNTH Blood count', 'Results outside the reference range', 'SYNTH-FIND-1',
      'Your results over time', 'Suggestions', 'SYNTH-ADVICE-1', 'Tests your doctor may consider', 'SYNTH-FOLLOW-1', DISCLAIMER_EN, 'Reviewed and approved by'))).toBe(true);
    const trendAt = t.indexOf('Glucose', t.indexOf('Your results over time'));
    expect(trendAt).toBeGreaterThanOrEqual(0);
    expect(trendAt).toBeLessThan(t.indexOf('Suggestions'));
    expect(html).toMatch(/<h2\b[^>]*class="smart-title"[^>]*>\s*Smart summary\s*<\/h2>/);
    expect(html).toMatch(/<p\b[^>]*class="smart-notice"/);
    expect(html).toMatch(/<p\b[^>]*class="smart-disclaimer"/);
    expect(html).toMatch(/<p\b[^>]*class="smart-meta"/);
    expect(html).toMatch(/<table\b[^>]*class="smart-trends"/);
    expect(html).toMatch(/<ul\b[^>]*class="smart-tiles"/);
    expect(html).toMatch(/<div\b[^>]*class="smart-score"/);
  });
  it.each(Object.keys(FIXTURES))('%s: only allowed elements/attributes, only smart-* classes that exist in print.css, no style / img / svg / script / link / URL', (k) => {
    const html = render(FIXTURES[k]!());
    expect(html.length).toBeGreaterThan(0);
    for (const t of tags(html)) {
      expect(ALLOWED_TAGS.has(t.name), `element <${t.name}>`).toBe(true);
      for (const [a, v] of Object.entries(t.attrs)) {
        expect(ALLOWED_ATTRS.has(a), `attribute ${a} on <${t.name}>`).toBe(true);
        if (a === 'class') for (const c of v.split(/\s+/).filter(Boolean)) { expect(c.startsWith('smart-'), c).toBe(true); expect(CSS_CLASSES.has(c), `${c} not in print.css`).toBe(true); }
      }
    }
    expect(html).not.toMatch(/<(script|img|svg|a|iframe|link|style)\b/i);
    expect(html).not.toMatch(/\bstyle\s*=|\bon\w+\s*=|\bhref\b|\bsrc\b|https?:|www\.|\/\/|url\(|javascript:|data:/i);
  });
  it('tiles: one li.smart-tile per panel with class smart-status-<status>, display name and the status word', () => {
    const html = render(approved());
    const lis = tags(html).filter((t) => t.name === 'li' && /\bsmart-tile\b/.test(t.attrs['class'] ?? ''));
    expect(lis.map((l) => (l.attrs['class'] ?? '').split(/\s+/).find((c) => c.startsWith('smart-status-')))).toEqual(
      ['smart-status-in_range', 'smart-status-borderline', 'smart-status-out_of_range', 'smart-status-critical']);
    const t = textOf(html);
    for (const [n, w] of [['SYNTH Blood count', 'In range'], ['SYNTH Fat profile', 'Borderline'], ['SYNTH Sugar', 'Out of range'], ['SYNTH Minerals', 'Critical']]) expect(t).toContain(`${n} ${w}`);
  });
  it('findings: given order kept; each entry shows direction word, severity word and the block text', () => {
    const html = render(approved());
    const rows = [['SYNTH-FIND-1', 'High', 'Out of range'], ['SYNTH-FIND-2', 'Low', 'Critical'], ['SYNTH-FIND-3', 'Abnormal', 'Borderline']] as const;
    for (const [id, dir, sev] of rows) { const li = textOf(liWith(html, id) ?? ''); expect(li, id).toContain(dir); expect(li, id).toContain(sev); expect(li).toContain(id); }
    expect(ascending(pos(textOf(html), 'SYNTH-FIND-1', 'SYNTH-FIND-2', 'SYNTH-FIND-3'))).toBe(true);
    expect(textOf(liWith(html, 'SYNTH-FIND-1') ?? '')).toContain('Glucose');
  });
  it('advice and follow-ups: texts in order; follow-up shows "(<test name>, after <n> days)"', () => {
    const t = textOf(render(approved()));
    expect(ascending(pos(t, 'SYNTH-ADVICE-1', 'SYNTH-ADVICE-2'))).toBe(true);
    expect(t).toContain('SYNTH-FOLLOW-1 Repeat the sugar control test.');
    expect(t).toContain('(Glycated haemoglobin, after 90 days)');
  });
  it('trend table: analyte, unit, points oldest → newest with verbatim values, direction word; th cells present', () => {
    const html = render(approved());
    const tbl = /<table\b[\s\S]*<\/table>/.exec(html)?.[0] ?? '';
    const t = textOf(tbl);
    expect(t).toContain('Glucose'); expect(t).toContain('mg/dL'); expect(t).toContain('Improved');
    expect(ascending(pos(t, '15.0', '10.50', '5.60'))).toBe(true);
    expect(tags(tbl).some((x) => x.name === 'th')).toBe(true);
  });
  it.each([['improved', 'Improved'], ['worsened', 'Worsened'], ['stable', 'Stable']])('trend direction %s prints "%s"', (d, w) => {
    const s = approved(); s.trends[0].direction = d;
    expect(textOf(/<table\b[\s\S]*<\/table>/.exec(render(s))?.[0] ?? '')).toContain(w);
  });
  it('numbers are printed verbatim: trailing zeros kept, no rounding or reformatting', () => {
    const t = textOf(render(approved()));
    expect(t).toContain('15.0'); expect(t).toContain('10.50'); expect(t).toContain('5.60');
    const s = approved({ healthScore: { value: 72.5, band: 'fair', formulaVersion: 'score-SYN-1', panelsScored: 4, explanationText: 'x' } });
    expect(textOf(render(s))).toContain('72.5 / 100');
  });
  it('deterministic and pure: same input twice → identical; frozen input is accepted', () => {
    const s = deepFreeze(approved());
    expect(render(s)).toBe(render(s));
  });
  it('lab-report integration: the real fragment goes through labReportTemplate (C6 hook) and its text reaches the document', () => {
    const { assets } = makeAssets();
    const doc = makeDoc({ smart: { summaryId: U(1), templateLibraryVersion: 'lib-SYN-1', payload: approved() } });
    const html = labReportTemplate.render({ document: doc, config: makeConfig(), variant: 'letterhead', assets, smart: smartSectionRenderer });
    const t = textOf(html);
    expect(t).toContain('Smart summary'); expect(t).toContain(NOTICE); expect(t).toContain('SYNTH-FIND-1'); expect(t).toContain(DISCLAIMER_EN);
  });
});

describe('AC-09.5 — health score', () => {
  it('prints the fixed label, "<value> / 100", band word, panelsScored and the approved explanation text', () => {
    const t = textOf(render(approved()));
    expect(t).toContain('Health score (not a diagnosis)');
    expect(t).toContain('72 / 100'); expect(t).toContain('Fair'); expect(t).toContain('Based on 4 body systems');
    expect(t).toContain('SYNTH-EXPLAIN The score reflects how many body systems are in range.');
  });
  it.each([['good', 100, 'Good'], ['fair', 50, 'Fair'], ['needs_attention', 0, 'Needs attention']])('band %s / value %i → "%s"', (band, value, word) => {
    const t = textOf(render(approved({ healthScore: { value, band, formulaVersion: 'score-SYN-1', panelsScored: 3, explanationText: 'SYNTH-EXPLAIN' } })));
    expect(t).toContain(`${value} / 100`); expect(t).toContain(word); expect(t).toContain('Based on 3 body systems');
  });
  it('no healthScore → no score block, no label, no "/ 100" (score is never invented)', () => {
    const html = render(noScore());
    expect(textOf(html)).not.toContain('Health score'); expect(textOf(html)).not.toMatch(/\/\s*100/);
    expect(html).not.toMatch(/smart-score/);
    expect(textOf(html)).toContain(NOTICE); expect(textOf(html)).toContain('SYNTH Blood count');
  });
});

describe('AC-18.1 / AC-16.1 — fixed notice, disclaimer, approval line; empty sections are omitted', () => {
  it.each(Object.keys(FIXTURES))('%s: contains the exact fixed notice N1 and the tenant disclaimer text', (k) => {
    const s = FIXTURES[k]!(); const t = textOf(render(s));
    expect(t).toContain(NOTICE); expect(t).toContain(s.disclaimerText);
  });
  it('even with every list empty the notice, disclaimer, title and meta are present', () => {
    const t = textOf(render(emptyFindings()));
    expect(t).toContain('Smart summary'); expect(t).toContain(NOTICE); expect(t).toContain(DISCLAIMER_EN); expect(t).toContain('Reviewed and approved by');
  });
  it('empty findings: no h3 headings, no lists of findings / advice / follow-ups, no trends table', () => {
    const html = render(emptyFindings()); const t = textOf(html);
    expect(tags(html).filter((x) => x.name === 'h3')).toHaveLength(0);
    for (const h of ['Results outside the reference range', 'Your results over time', 'Suggestions', 'Tests your doctor may consider']) expect(t).not.toContain(h);
    expect(html).not.toMatch(/<table\b/); expect(html).not.toMatch(/SYNTH-(FIND|ADVICE|FOLLOW)/);
  });
  it('no trends: trends heading and table absent, other sections intact', () => {
    const html = render(noTrends()); const t = textOf(html);
    expect(t).not.toContain('Your results over time'); expect(html).not.toMatch(/<table\b|smart-trends/);
    expect(t).toContain('Results outside the reference range'); expect(t).toContain('Suggestions'); expect(t).toContain('Tests your doctor may consider');
  });
  it('approval line: "Reviewed and approved by the laboratory\'s pathologist on <date>. Summary library version <v>; score formula <f>."', () => {
    const t = textOf(render(approved()));
    expect(t).toContain("Reviewed and approved by the laboratory's pathologist on");
    expect(t).toContain('Summary library version lib-SYN-1'); expect(t).toContain('score formula score-SYN-1');
  });
});

describe('dates honour calendarDisplay and timezone (bsdate; 02-CV §13)', () => {
  const ad = (iso: string, tz = TZ) => formatAd(iso as IsoUtc, tz).slice(0, 10);
  const bs = (iso: string, tz = TZ) => formatBs(instantToBs(iso as IsoUtc, tz), 'display');
  const POINTS = ['2025-11-02T04:15:00Z', '2026-05-03T04:15:00Z', APPROVED_AT];
  it('AD: approval date and every trend point date in DD/MM/YYYY', () => {
    const t = textOf(render(approved(), 'AD'));
    for (const p of POINTS) expect(t).toContain(ad(p));
    expect(t).not.toContain(bs(APPROVED_AT));
  });
  it('BS: dates printed in B.S. display form, not A.D.', () => {
    const t = textOf(render(approved(), 'BS'));
    for (const p of POINTS) expect(t).toContain(bs(p));
    expect(t).not.toContain(ad(APPROVED_AT));
  });
  it.each(['AD_BS', 'BS_AD'])('%s: both forms of the approval date', (mode) => {
    const t = textOf(render(approved(), mode));
    expect(t).toContain(ad(APPROVED_AT)); expect(t).toContain(bs(APPROVED_AT));
  });
  it('timezone is applied: 2026-11-05T20:30:00Z is 06/11/2026 in Asia/Kathmandu but 05/11/2026 in UTC', () => {
    const s = approved({ approvedAt: '2026-11-05T20:30:00Z' });
    expect(textOf(render(s, 'AD', 'Asia/Kathmandu'))).toContain('06/11/2026');
    expect(textOf(render(s, 'AD', 'UTC'))).toContain('05/11/2026');
  });
});

describe('AC-16.2 — all text is escaped (REQ-SEC-088, 07-SECURITY T8)', () => {
  const hostile = () => {
    const s = approved(); const H = (m: string) => `${m} ${HOSTILE}`;
    s.disclaimerText = H('D'); s.healthScore.explanationText = H('E');
    s.panels.forEach((p: any, i: number) => { p.displayName = H(`P${i}`); });
    s.deranged.forEach((d: any, i: number) => { d.text = H(`F${i}`); d.analyteName = H(`A${i}`); });
    s.advice.forEach((a: any, i: number) => { a.text = H(`V${i}`); });
    s.followUps.forEach((f: any, i: number) => { f.text = H(`U${i}`); f.suggestedTestName = H(`T${i}`); });
    s.trends.forEach((x: any, i: number) => { x.analyteName = H(`R${i}`); x.unitCode = H(`C${i}`); });
    s.templateLibraryVersion = H('L'); s.healthScore.formulaVersion = H('X');
    return s;
  };
  it('markup in any text field becomes visible text: no <b>, <script>, <img>, <a> element or attribute is created', () => {
    const html = render(hostile());
    for (const t of tags(html)) { expect(ALLOWED_TAGS.has(t.name), `<${t.name}>`).toBe(true); for (const a of Object.keys(t.attrs)) expect(ALLOWED_ATTRS.has(a), a).toBe(true); }
    expect(html).not.toMatch(/<\s*(b|script|img|a)\b/i);
    expect(html).not.toContain('onerror=alert'); expect(html).not.toMatch(/href\s*=/i);
  });
  it('the literal text (<b>bold</b> & …) is present once decoded, in every field', () => {
    const t = textOf(render(hostile()));
    for (const m of ['D', 'E', 'P0', 'F0', 'A0', 'V0', 'U0', 'T0', 'R0', 'C0']) expect(t, m).toContain(`${m} <b>bold</b> & <script>alert(1)</script> <img src=x onerror=alert(2)>`);
  });
  it('a bare "&" and "<b>" in a block text are encoded in the source (&amp; / &lt;)', () => {
    const html = render(approved({ advice: [{ templateBlockId: U(51), text: 'Fish & <b>chips</b>' }] }));
    expect(html).not.toContain('<b>'); expect(html).not.toMatch(/&(?!#?\w+;)/); expect(textOf(html)).toContain('Fish & <b>chips</b>');
  });
  it('a quote in a text cannot break out into an attribute (no attribute is ever built from input)', () => {
    const html = render(approved({ deranged: [{ ...approved().deranged[0], text: '" onmouseover="alert(1)', analyteName: "' autofocus='" }] }));
    expect(tags(html).flatMap((t) => Object.keys(t.attrs)).filter((a) => !ALLOWED_ATTRS.has(a))).toEqual([]);
  });
  it('fields the contract does not render (price, bookingUrl, phone, unknown) are never printed', () => {
    const s = approved(); s.followUps[0].price = 'NPR 5000'; s.followUps[0].bookingUrl = 'https://book.invalid/x'; s.followUps[0].phone = '9800000000'; s.extra = 'SYNTH-EXTRA';
    const html = render(s); const t = textOf(html);
    for (const x of ['NPR 5000', 'book.invalid', '9800000000', 'SYNTH-EXTRA']) expect(html + t).not.toContain(x);
  });
});

describe('AC-12.4 — no price, booking link or phone number in the rendering', () => {
  it.each(Object.keys(FIXTURES))('%s: no currency, booking/appointment wording, link, mail or phone shape', (k) => {
    const html = render(FIXTURES[k]!()); const t = textOf(html);
    expect(t).not.toMatch(/[$₹€£]|\b(?:NPR|INR|USD|Rs)\b|रु\b|\b(?:price|cost|discount|offer|book|booking|appointment|whatsapp|phone|call)\b/i);
    expect(t).not.toMatch(/\+?\d{7,}|\b\d{3}[ -]\d{3,4}[ -]\d{3,4}\b/);
    expect(html).not.toMatch(/tel:|mailto:|https?:|www\.|@/i);
  });
});

describe('Devanagari (library language ne) — verbatim text, lang="ne" on the text elements, fixed copy stays English', () => {
  it('prints every Devanagari block text unchanged (no normalisation, no truncation)', () => {
    const s = devanagari(); const t = textOf(render(s));
    for (const x of [s.disclaimerText, s.healthScore.explanationText, s.panels[0].displayName, s.panels[1].displayName, s.deranged[0].text, s.deranged[0].analyteName, s.advice[0].text, s.followUps[0].text, s.followUps[0].suggestedTestName]) expect(t).toContain(x);
    expect(t).toContain(NOTICE); expect(t).toContain('Smart summary');
  });
  it('every text node containing Devanagari sits inside an element with lang="ne"', () => {
    const html = render(devanagari()); const stack: boolean[] = []; let bad = 0; let seen = 0;
    for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
      if (m[4] !== undefined) { if (/[ऀ-ॿ]/.test(decode(m[4]))) { seen++; if (!stack.some(Boolean)) bad++; } continue; }
      if (m[1]) stack.pop(); else stack.push(/\blang="ne"/.test(m[3] ?? ''));
    }
    expect(seen).toBeGreaterThan(0); expect(bad).toBe(0);
  });
  it('the fixed English notice element is not marked lang="ne"; an English summary has no lang="ne" at all', () => {
    expect(/<p\b[^>]*class="smart-notice"[^>]*>/.exec(render(devanagari()))?.[0]).not.toMatch(/lang="ne"/);
    expect(render(approved())).not.toMatch(/lang="ne"/);
  });
});

describe('AC-16.3 — a non-approved summary renders nothing and logs smart_render_not_approved (no PHI)', () => {
  function capture() {
    const lines: string[] = [];
    const push = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(push);
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    return lines;
  }
  it('draft → empty string, "smart_render_not_approved" logged, block texts / names / summary content never logged', () => {
    const lines = capture();
    const out = render(approved({ status: 'draft' }));
    expect(out).toBe('');
    const log = lines.join('\n');
    expect(log).toContain('smart_render_not_approved');
    for (const x of ['SYNTH-FIND-1', 'SYNTH-ADVICE-1', 'SYNTH-DISCLAIMER', 'Glucose', 'Glycated']) expect(log).not.toContain(x);
  });
  it.each([['draft with approval fields', { status: 'draft', approvedAt: APPROVED_AT, approvedByMembershipId: U(3) }], ['unknown status', { status: 'APPROVED' }], ['missing status', { status: undefined }]])('%s → empty string', (_n, over) => {
    capture(); expect(render(approved(over as Record<string, unknown>))).toBe('');
  });
  it.each([[null], [undefined], ['x'], [42], [{}]])('garbage summary %j → empty string, never throws', (bad) => {
    capture(); expect(() => render(bad)).not.toThrow(); expect(render(bad)).toBe('');
  });
  it('an approved summary does not log smart_render_not_approved', () => {
    const lines = capture(); expect(render(approved())).not.toBe('');
    expect(lines.join('\n')).not.toContain('smart_render_not_approved');
  });
  it('through the lab template a draft payload adds no smart text to the document', () => {
    const { assets } = makeAssets(); capture();
    const doc = makeDoc({ smart: { summaryId: U(1), templateLibraryVersion: 'lib-SYN-1', payload: approved({ status: 'draft' }) } });
    const t = textOf(labReportTemplate.render({ document: doc, config: makeConfig(), variant: 'letterhead', assets, smart: smartSectionRenderer }));
    for (const x of ['Smart summary', 'SYNTH-FIND-1', NOTICE, DISCLAIMER_EN]) expect(t).not.toContain(x);
  });
});

describe('robustness — optional display fields missing (builds before 08 fields) never print undefined/null and never throw', () => {
  it('summary without displayName / analyteName / suggestedTestName / unitCode / points / explanationText / disclaimerText', () => {
    const s = approved();
    s.panels.forEach((p: any) => delete p.displayName); s.deranged.forEach((d: any) => delete d.analyteName); s.followUps.forEach((f: any) => delete f.suggestedTestName);
    s.trends.forEach((x: any) => { delete x.analyteName; delete x.unitCode; delete x.points; }); delete s.healthScore.explanationText; delete s.disclaimerText;
    let html = ''; expect(() => { html = render(s); }).not.toThrow();
    expect(textOf(html)).not.toMatch(/undefined|null|\[object|NaN/); expect(textOf(html)).toContain(NOTICE);
  });
});

describe('C6 sanitiser profile (02-TRD §7 Renderer row; C6 02-TRD §5.3 "same sanitiser profile")', () => {
  // ASSUMED/FLAG: the current narrative sanitiser (src/templates/narrative/sanitize.ts, used by lab/index.ts on the smart fragment) keeps only a formatting allowlist and
  // drops every attribute and <section>/<div>. A literal byte-for-byte "unchanged" is therefore impossible for a fragment that carries smart-* classes. The enforceable
  // contract tested here: (1) the fragment already stays inside the spec profile (shape tests above), (2) the sanitiser removes none of its text, headings, lists or tables.
  const KEEP = new Set(['p', 'ul', 'ol', 'li', 'h2', 'h3', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'strong']);
  it.each(Object.keys(FIXTURES))('%s: sanitizeHtml(fragment) keeps all visible text and every sanitiser-allowed element', (k) => {
    const html = render(FIXTURES[k]!()); const out = sanitizeHtml(html);
    expect(textOf(out)).toBe(textOf(html));
    const count = (h: string) => tags(h).filter((t) => KEEP.has(t.name) && !t.close).map((t) => t.name).sort();
    expect(count(out)).toEqual(count(html));
  });
  it('a second pass is stable (sanitising the sanitised fragment changes nothing)', () => {
    const once = sanitizeHtml(render(approved())); expect(sanitizeHtml(once)).toBe(once);
  });
});

describe('snapshots — reviewed fragment per fixture (AD, Asia/Kathmandu)', () => {
  it.each(Object.keys(FIXTURES))('%s', (k) => { expect(render(FIXTURES[k]!())).toMatchSnapshot(); });
});
