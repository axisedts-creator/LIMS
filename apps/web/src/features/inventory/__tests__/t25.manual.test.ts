// C12.T-25 manual + in-app help checks (plan row T-25; 04-UI-UX §7; PRD §1.1, §8.3, AC-13.3; 07-SECURITY D-NOTE; 03-APP-FLOW E14; plan R7/R8).
// Static file checks only. LD-140 (2026-11-13): UI work uses kit components only; help is plain markdown, so no hex/px/inline style or raw HTML may appear in it.
// Naming (pinned here; same convention as docs/manual/lab + features/lab/help): <helpKey tail>.md. Screen pages use the helpKey tails already used by PageHeader in features/inventory.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url)); // repo root
const manualDir = join(root, 'docs/manual/inventory');
const helpDir = join(root, 'apps/web/src/features/inventory/help');
const compDir = join(root, 'apps/web/src/features/inventory/components');
const prd = join(root, 'spec/chunks/C12-inventory/01-PRD.md');

// S1..S18 (04-UI-UX §3). [screen, helpKey tail, route fragment the page must mention (null = no own route in spec)]
const SCREENS: Array<[string, string, string | null]> = [
  ['S1', 'home', '/inventory'],
  ['S2', 'items', '/inventory/items'],
  ['S3', 'item', '/inventory/items'],
  ['S4', 'stores', '/inventory/stores'],
  ['S5', 'suppliers', '/inventory/suppliers'],
  ['S6', 'purchase_orders', '/inventory/purchase-orders'],
  ['S7', 'receipts', '/inventory/receipts'],
  ['S8', 'stock', '/inventory/stock'],
  ['S9', 'transfers', '/inventory/transfers'],
  ['S10', 'wastage', '/inventory/wastage'],
  ['S11', 'counts', '/inventory/counts'],
  ['S12', 'bench', '/inventory/bench'],
  ['S13', 'rules', null],
  ['S14', 'bindings', null],
  ['S15', 'unresolved', '/inventory/unresolved'],
  ['S16', 'alerts', '/inventory/alerts'],
  ['S17', 'reports', '/inventory/reports'],
  ['S18', 'settings', '/inventory/settings'],
];
const TOPICS = ['consumption-model', 'cost-per-test', 'stock-count', 'vat-in-cost'];

const read = (p: string) => readFileSync(p, 'utf8');
const man = (n: string) => read(join(manualDir, `${n}.md`));
const help = (n: string) => read(join(helpDir, `${n}.md`));
const norm = (s: string) => s.replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ').trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// PRD §1.1 client-facing explanation: the blockquote after "Client-facing explanation", outer quotes stripped.
const verbatim = (() => {
  const m = read(prd).match(/Client-facing explanation[^\n]*\s+>\s*"([\s\S]*?)"\s*(?:\r?\n|$)/);
  return m ? norm(m[1]!) : '';
})();

describe('spec fixture', () => {
  it('PRD §1.1 text is found (guards the verbatim checks below)', () => {
    expect(verbatim.startsWith('Your analysers send us patient results')).toBe(true);
    expect(verbatim.endsWith('The counting model stays the record either way.')).toBe(true);
  });
});

describe('files exist (done_when: one page per screen + four topic pages)', () => {
  it.each(SCREENS)('%s manual page docs/manual/inventory/%s.md', (_s, k) => {
    // second column is the key tail
    expect(existsSync(join(manualDir, `${k}.md`)), `${k}.md`).toBe(true);
  });
  it.each(TOPICS)('topic page docs/manual/inventory/%s.md', (t) => expect(existsSync(join(manualDir, `${t}.md`)), `${t}.md`).toBe(true));
  it.each(SCREENS)('%s in-app help help/%s.md', (_s, k) => expect(existsSync(join(helpDir, `${k}.md`)), `${k}.md`).toBe(true));
  it('in-app help for inventory.help.consumption_model: help/consumption_model.md', () => expect(existsSync(join(helpDir, 'consumption_model.md'))).toBe(true));
  it('no stray .md in docs/manual/inventory beyond 18 screens + 4 topics (README.md allowed)', () => {
    const allowed = new Set([...SCREENS.map(([, k]) => `${k}.md`), ...TOPICS.map((t) => `${t}.md`), 'README.md']);
    const extra = existsSync(manualDir) ? readdirSync(manualDir).filter((f) => f.endsWith('.md') && !allowed.has(f)) : [];
    expect(extra).toEqual([]);
  });
  it('every helpKey used by a PageHeader in features/inventory has a help page', () => {
    const keys = new Set<string>();
    for (const f of readdirSync(compDir).filter((n) => /\.tsx$/.test(n)))
      for (const m of read(join(compDir, f)).matchAll(/helpKey="inventory\.([a-z_]+)"/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(5);
    for (const k of keys) expect(existsSync(join(helpDir, `${k}.md`)), `help/${k}.md for helpKey inventory.${k}`).toBe(true);
  });
});

describe('page shape', () => {
  it.each(SCREENS)('%s manual page: H1, at least 40 words, mentions its screen route', (_s, k, route) => {
    const s = man(k);
    expect(s).toMatch(/^# \S/m);
    expect(words(s)).toBeGreaterThanOrEqual(40);
    if (route) expect(s).toContain(route);
  });
  it.each(SCREENS)('%s help page: H1, at least 25 words', (_s, k) => {
    const s = help(k);
    expect(s).toMatch(/^# \S/m);
    expect(words(s)).toBeGreaterThanOrEqual(25);
  });
  it.each(TOPICS)('topic %s: H1, at least 60 words', (t) => {
    const s = man(t);
    expect(s).toMatch(/^# \S/m);
    expect(words(s)).toBeGreaterThanOrEqual(60);
  });
});

describe('consumption model text matches PRD §1.1 verbatim (done_when)', () => {
  it('docs/manual/inventory/consumption-model.md contains it', () => expect(norm(man('consumption-model'))).toContain(verbatim));
  it('help/consumption_model.md contains it', () => expect(norm(help('consumption_model'))).toContain(verbatim));
  it('manual page also explains how rules work (04 §7)', () => {
    const s = man('consumption-model');
    for (const re of [/rule/i, /analyser/i, /per test|per-test/i, /QC/, /calibration/i, /rerun/i]) expect(s).toMatch(re);
  });
  it('AC-13.3: rerun detection depends on the analyser driver reporting reruns; UNVERIFIED per model (B2)', () => {
    for (const s of [man('consumption-model'), man('rules'), help('rules')]) {
      expect(s).toMatch(/rerun/i);
      expect(s).toMatch(/driver/i);
      expect(s).toMatch(/UNVERIFIED/);
    }
  });
});

describe('no analyser-telemetry claim (PRD §1.1 last paragraph; CV §0)', () => {
  const pages = (): Array<[string, string]> => [
    ...SCREENS.map(([, k]) => [`manual/${k}`, man(k)] as [string, string]),
    ...TOPICS.map((t) => [`manual/${t}`, man(t)] as [string, string]),
    ...SCREENS.map(([, k]) => [`help/${k}`, help(k)] as [string, string]),
    ['help/consumption_model', help('consumption_model')],
  ];
  it('no page says reagent or on-board levels are live / real-time', () => {
    for (const [n, s] of pages()) {
      const t = norm(s);
      expect(t, n).not.toMatch(/\b(live|real[- ]time)\b[^.]{0,40}\b(reagent|on-?board)\b/i);
      expect(t, n).not.toMatch(/\b(reagent|on-?board)\b[^.]{0,40}\b(live|real[- ]time)\b/i);
      expect(t, n).not.toMatch(/\b(reads?|reading|receives?|streams?)\b[^.]{0,30}\breagent levels?\b/i);
    }
  });
});

describe('links to the consumption-model explanation (04 §1: from S1, S13, S17; plan R8)', () => {
  it.each(['home', 'rules', 'reports'])('help/%s.md links to consumption_model', (k) => expect(help(k)).toMatch(/consumption[_-]model/));
  it.each(['home', 'rules', 'reports'])('manual/%s.md links to consumption-model.md', (k) => expect(man(k)).toMatch(/consumption-model(\.md)?/));
});

describe('topic pages carry the spec facts', () => {
  it('cost-per-test: direct, loaded and fixed cost in plain language; wastage kept out; rounding; cost permission (PRD §8.3, §2)', () => {
    const s = man('cost-per-test');
    for (const re of [/cost per test/i, /direct/i, /loaded/i, /fixed/i, /wastage/i, /not (part of|included|counted)/i, /round/i, /inventory\.cost\.read/]) expect(s).toMatch(re);
  });
  it('stock-count: blind count, system quantity switch needs adjust permission, uncounted policy both options (04 S11)', () => {
    const s = man('stock-count');
    for (const re of [/blind/i, /show system quantity/i, /inventory\.stock\.adjust/, /Leave uncounted lines unchanged/, /Treat uncounted lines as zero/]) expect(s).toMatch(re);
  });
  it('stock-count: back-dated movements change past valuation (03 E14 DECISION documented in help)', () => {
    expect(man('stock-count')).toMatch(/back-?dat/i);
    expect(help('counts')).toMatch(/back-?dat/i);
  });
  it('vat-in-cost: B7 switch text and "future receipts only" (04 S18; plan R7)', () => {
    const s = norm(man('vat-in-cost'));
    expect(s).toContain('Turn off if your lab can claim purchase VAT back (ask your auditor).');
    expect(s).toMatch(/future receipts/i);
    expect(norm(help('settings'))).toContain('Turn off if your lab can claim purchase VAT back (ask your auditor).');
  });
});

describe('screen copy that the spec says help must carry', () => {
  it.each([['manual', man], ['help', help]] as const)('%s bench page: "Do not enter patient details." (07 D-NOTE)', (_n, f) => expect(norm(f('bench'))).toContain('Do not enter patient details.'));
  it.each([['manual', man], ['help', help]] as const)('%s bench page: open-container analyser hint (04 S12)', (_n, f) =>
    expect(norm(f('bench'))).toContain('Choose the analyser this bottle is loaded on. Automatic deductions for that analyser use this lot.'));
  it('rules + settings pages explain automatic consumption can be off (04 S1/S18)', () => {
    expect(help('settings')).toMatch(/automatic consumption/i);
    expect(man('settings')).toMatch(/automatic consumption/i);
  });
});

describe('safety of the content (synthetic data only; LD-140 plain markdown)', () => {
  const all = (): Array<[string, string]> => [
    ...SCREENS.flatMap(([, k]) => [[`manual/${k}`, man(k)], [`help/${k}`, help(k)]] as Array<[string, string]>),
    ...TOPICS.map((t) => [`manual/${t}`, man(t)] as [string, string]),
    ['help/consumption_model', help('consumption_model')],
  ];
  it('no secrets, e-mail addresses, phone numbers, hex colours, inline style or raw HTML', () => {
    for (const [n, s] of all()) {
      expect(s, n).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(s, n).not.toMatch(/\b(?:\+?\d[\s-]?){10,}\b/);
      expect(s, n).not.toMatch(/(api[_-]?key|secret|password|bearer)\s*[:=]\s*\S+/i);
      expect(s, n).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(s, n).not.toMatch(/<\s*(script|style|iframe|img)\b|\bstyle\s*=/i);
    }
  });
  it('no unfinished placeholders', () => {
    for (const [n, s] of all()) expect(s, n).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b/i);
  });
});
