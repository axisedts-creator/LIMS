// AN-T24 Help + manual — review-checklist tests. Spec: 04-UI-UX §12 (help/<screen>.md per screen explaining every metric with its M-id in plain words,
// business-day rule, B.S. periods, freshness, centre scope; docs/manual/analytics mirrors them with synthetic screenshots), §13 copy keys, PRD IS-20, §8 metric dictionary,
// PRD US-07.3 (no payout wording anywhere in C8 copy). Plan row AN-T24: "every screen has help; manual with synthetic screenshots".
// ASSUMED naming (dispute if wrong): help file = help/<last dot-segment of the screen's helpKey>.md  (analytics.reports.income -> income.md, analytics.report_run -> report_run.md,
// analytics.reports.referral-incentive -> referral-incentive.md). Manual = README.md + dashboard.md, reports.md, referral-incentive.md, exports.md, schedules.md;
// screenshots = PNG files under docs/manual/analytics/images/ referenced as markdown images.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const feat = join(root, 'apps/web/src/features/analytics');
const helpDir = join(feat, 'help');
const manualDir = join(root, 'docs/manual/analytics');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);
const WORD = ['commis', 'sion'].join(''); // never spell the banned word in this file

// ---- screens = every helpKey the C8 UI passes to PageHeader (a new screen without help fails here)
const reportsSrc = read(join(feat, 'server/reports.server.ts'));
const slugs = [...new Set([...reportsSrc.matchAll(/slug:\s*'([a-z-]+)'/g)].map((m) => m[1]!))].sort();
const compsDir = join(feat, 'components');
const literalKeys = [...new Set(readdirSync(compsDir).filter((n) => n.endsWith('.tsx')).flatMap((n) => [...read(join(compsDir, n)).matchAll(/helpKey="analytics\.([a-z_.-]+)"/g)].map((m) => m[1]!)))];
const screens = [...new Set([...literalKeys.map((k) => k.split('.').pop()!), ...slugs])].sort();
const helpOf = (k: string) => read(join(helpDir, `${k}.md`));
const manualText = () => mdIn(manualDir).map((n) => read(join(manualDir, n))).join('\n');

// ---- per-screen requirements (PRD §8.2 metric ids; UI-UX §13 copy keys paraphrased as regexes)
const METRICS: Record<string, string[]> = {
  dashboard: ['M04', 'M12', 'M27'],
  income: ['M10', 'M11', 'M12'],
  'department-income': ['M21', 'M22'],
  collections: ['M25', 'M26', 'M27'],
  volume: ['M01', 'M03', 'M04'],
  'top-referrers': ['M30', 'M31', 'M32'],
  'top-centres': ['M35', 'M38'],
  'tests-done': ['M40', 'M47'],
  tat: ['M60', 'M61', 'M62', 'M63', 'M64'],
  'pending-tests': ['M50', 'M51'],
  'quality-indicators': ['M70', 'M72', 'M73'],
  delivery: ['M80'],
  interfaces: ['M90', 'M91'],
  'referral-incentive': ['M33'],
};
const NO_PERIOD = ['pending-tests', 'exports', 'schedules', 'report_run']; // screens without a B.S./A.D. period selector
const CENTRE_SCOPE = (t: string) => /centre/i.test(t) && /(scope|access|only (the )?centres?|your centres?|all centres)/i.test(t);

describe('AN-T24 help: every analytics screen', () => {
  it('discovers the C8 screens (non-vacuous)', () => {
    expect(screens.length).toBeGreaterThanOrEqual(17);
    expect(screens).toEqual(expect.arrayContaining(['dashboard', 'income', 'department-income', 'collections', 'volume', 'top-referrers', 'top-centres', 'tests-done', 'tat',
      'pending-tests', 'quality-indicators', 'delivery', 'interfaces', 'referral-incentive', 'exports', 'schedules', 'report_run']));
  });
  it.each(screens)('help/%s.md exists with title, Purpose and Fields/Metrics headings', (k) => {
    const p = join(helpDir, `${k}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = helpOf(k);
    expect(t.length).toBeGreaterThan(400);
    expect(t).toMatch(/^#\s+\S/m);
    expect(t, `${k}.md needs a Purpose heading`).toMatch(/^#{2,3}\s+.*Purpose/im);
    expect(t, `${k}.md needs a Fields or Metrics heading`).toMatch(/^#{2,3}\s+.*(Fields|Metrics)/im);
  });
  it('no orphan help files (each maps to a screen)', () => {
    expect(mdIn(helpDir).filter((n) => !screens.includes(n.replace(/\.md$/, '')))).toEqual([]);
  });
});

describe('AN-T24 help content (04-UI-UX §12: metrics with M-ids, business day, B.S., freshness, centre scope)', () => {
  it.each(Object.entries(METRICS))('%s names its metrics by M-id', (k, ids) => {
    const t = helpOf(k);
    for (const id of ids) expect(t, `${k}.md must define ${id} in plain words`).toMatch(new RegExp(`\\b${id}\\b`));
  });
  it.each(screens)('%s explains freshness and centre scope', (k) => {
    const t = helpOf(k);
    expect(t, `${k}.md: freshness`).toMatch(/fresh|updated|out of date|stale/i);
    if (!['exports', 'schedules', 'report_run'].includes(k)) expect(CENTRE_SCOPE(t), `${k}.md: centre scope`).toBe(true);
  });
  it.each(screens.filter((k) => !NO_PERIOD.includes(k)))('%s explains Nepal-time business day and B.S. periods', (k) => {
    const t = helpOf(k);
    expect(t, `${k}.md: business day`).toMatch(/business day/i);
    expect(t, `${k}.md: Nepal time`).toMatch(/Nepal time|UTC\+05:45/);
    expect(t, `${k}.md: B.S.`).toMatch(/B\.S\./);
    expect(t, `${k}.md: A.D.`).toMatch(/A\.D\./);
  });
  it('dashboard: patient visits are visit-days, not distinct persons (analytics.metric.patient_visits.help)', () => {
    for (const k of ['dashboard', 'volume']) expect(helpOf(k), k).toMatch(/same (person|patient)[^.]*more than once|patient-days|visit-days/i);
  });
  it('income: invoices minus credit notes, cash shown separately, reconciles to registers', () => {
    const t = helpOf('income');
    expect(t).toMatch(/credit notes?/i);
    expect(t).toMatch(/cash collected/i);
    expect(t).toMatch(/sales register/i);
  });
  it('collections: cash basis, differs from income', () => {
    const t = helpOf('collections');
    expect(t).toMatch(/cash basis/i);
    expect(t).toMatch(/differs from income|not (the same as|equal to) income|earlier invoices/i);
  });
  it('pending tests: age anchor sentence + live snapshot', () => {
    const t = helpOf('pending-tests');
    expect(t).toMatch(/since receipt at the lab/i);
    expect(t).toMatch(/registration/i);
  });
  it('top referrers + referral report: net billed is not the referrer\'s share of income; SELF', () => {
    expect(helpOf('top-referrers')).toMatch(/SELF/);
    expect(helpOf('referral-incentive')).toMatch(/net billed/i);
    expect(helpOf('referral-incentive')).toMatch(/not (equal to|the same as)[^.]*(income|net sales)|differs from[^.]*(income|net sales)/i);
  });
  it('referral report: internal review only, viewing is recorded (analytics.referral.*)', () => {
    const t = helpOf('referral-incentive');
    expect(t).toMatch(/internal review/i);
    expect(t).toMatch(/(viewing|views?)[^.]*recorded|recorded[^.]*view/i);
  });
  it('exports: not a statutory register; MFA/step-up mentioned', () => {
    const t = helpOf('exports');
    expect(t).toMatch(/not a statutory register/i);
    expect(t).toMatch(/MFA|multi-factor|verification code/i);
  });
  it('schedules: recipients get a link only and must sign in', () => {
    const t = helpOf('schedules');
    expect(t).toMatch(/link only|only a link|email with a link/i);
    expect(t).toMatch(/sign in/i);
  });
  it('tat: the five segments are explained with their start and end events', () => {
    const t = helpOf('tat');
    expect(t).toMatch(/Collection[^.\n]*receipt at lab/i);
    expect(t).toMatch(/scan-out[^.\n]*scan-in/i);
    expect(t).toMatch(/first (verified )?(result|report)/i);
  });
});

describe('AN-T24 manual (docs/manual/analytics)', () => {
  it('has an index and one page per screen group, all non-trivial', () => {
    for (const n of ['README', 'dashboard', 'reports', 'referral-incentive', 'exports', 'schedules']) {
      const p = join(manualDir, `${n}.md`);
      expect(existsSync(p), `missing ${p}`).toBe(true);
      expect(read(p).length, p).toBeGreaterThan(400);
    }
  });
  it('mirrors help: every analytics screen route is covered', () => {
    const t = manualText();
    for (const r of ['/analytics', '/analytics/collections', '/analytics/referral-incentive', '/analytics/exports', '/analytics/schedules', '/analytics/report-runs'])
      expect(t, `manual does not mention ${r}`).toContain(r);
    for (const s of slugs.filter((x) => !['collections', 'referral-incentive'].includes(x))) expect(t, `manual does not mention /analytics/reports/${s}`).toContain(`/analytics/reports/${s}`);
  });
  it('manual states the same rules as help (Nepal-time business day, B.S., freshness)', () => {
    const t = manualText();
    expect(t).toMatch(/Nepal time/);
    expect(t).toMatch(/B\.S\./);
    expect(t).toMatch(/fresh|updated|out of date/i);
    expect(t).toMatch(/not a statutory register/i);
  });
  it('manual links every help-covered metric id used in its tables (M12 income, M33 referral)', () => {
    const t = manualText();
    for (const id of ['M12', 'M27', 'M33']) expect(t).toMatch(new RegExp(`\\b${id}\\b`));
  });
});

describe('AN-T24 manual screenshots are synthetic and resolvable', () => {
  const imgs = mdIn(manualDir).flatMap((n) => [...read(join(manualDir, n)).matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ page: n, alt: m[1]!, src: m[2]! })));
  it('at least 6 screenshots in total, and at least one on each of dashboard, reports, referral-incentive, exports, schedules', () => {
    expect(imgs.length).toBeGreaterThanOrEqual(6);
    for (const n of ['dashboard', 'reports', 'referral-incentive', 'exports', 'schedules']) expect(imgs.some((i) => i.page === `${n}.md`), `${n}.md has no screenshot`).toBe(true);
  });
  it('every image link is local, exists, is a real PNG, and is under 1.5 MB', () => {
    expect(imgs.length).toBeGreaterThan(0);
    for (const i of imgs) {
      expect(i.src, `${i.page}: remote image`).not.toMatch(/^[a-z]+:\/\//i);
      const p = resolve(manualDir, i.src);
      expect(p.startsWith(manualDir), `${i.page}: image escapes the manual folder`).toBe(true);
      expect(existsSync(p), `${i.page}: missing ${i.src}`).toBe(true);
      const b = readFileSync(p);
      expect(b.subarray(0, 8).toString('hex'), `${i.src} is not a PNG`).toBe('89504e470d0a1a0a');
      expect(statSync(p).size, i.src).toBeGreaterThan(200);
      expect(statSync(p).size, i.src).toBeLessThan(1_500_000);
    }
  });
  it('every screenshot has alt text and is captioned as synthetic data', () => {
    for (const i of imgs) expect(i.alt.trim().length, `${i.page}: empty alt for ${i.src}`).toBeGreaterThan(5);
    for (const n of mdIn(manualDir).filter((x) => x !== 'README.md' && imgs.some((i) => i.page === x))) expect(read(join(manualDir, n)), `${n}: must say screenshots use synthetic data`).toMatch(/synthetic/i);
  });
  it('no orphan images in the manual folder', () => {
    const dir = join(manualDir, 'images');
    const used = new Set(imgs.map((i) => resolve(manualDir, i.src)));
    const all = existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)) : [];
    expect(all.filter((f) => !used.has(resolve(f)))).toEqual([]);
  });
  it('help and manual contain no real-looking contact data or secrets', () => {
    const files = [...mdIn(helpDir).map((n) => join(helpDir, n)), ...mdIn(manualDir).map((n) => join(manualDir, n))];
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap((f) => read(f).split(/\r?\n/).flatMap((l, i) => {
      const bad: string[] = [];
      for (const m of l.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) if (!/(^|\.)(example\.(com|org|net)|test|invalid|example|localhost)$/i.test(m[1]!)) bad.push(`email ${m[0]}`);
      if (/\b(Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|eyJ[A-Za-z0-9_-]{20,})/i.test(l)) bad.push('secret-like');
      return bad.map((b) => `${f}:${i + 1}: ${b}`);
    }));
    expect(hits).toEqual([]);
  });
});

describe('AN-T24 copy rules (PRD US-07.3, c8-no-commission)', () => {
  it('no payout wording in help or manual (line-level, case-insensitive)', () => {
    const files = [...mdIn(helpDir).map((n) => join(helpDir, n)), ...mdIn(manualDir).map((n) => join(manualDir, n))];
    expect(files.length).toBeGreaterThan(20); // help (>=17) + manual (>=6) must exist
    const re = new RegExp(WORD, 'i');
    const hits = files.flatMap((f) => read(f).split(/\r?\n/).flatMap((l, i) => (re.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
    expect(dirname(manualDir)).toBeTruthy();
  });
  it('screenshot file names do not contain the banned word either', () => {
    const dir = join(manualDir, 'images');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => new RegExp(WORD, 'i').test(n))).toEqual([]);
  });
  it('report-hub help does not claim the figures are a statutory or tax filing', () => {
    for (const k of ['income', 'collections', 'referral-incentive']) expect(helpOf(k), k).not.toMatch(/IRD[ -](approved|compliant|certified|filing)|statutory (return|filing)/i);
  });
});
