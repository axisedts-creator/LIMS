// C5.T-33 Lab help + manual — doc lint. Spec: 04-UI-UX §3 (one page per screen), §6 (each screen ships
// features/lab/help/<screen>.md and docs/manual/lab/<screen>.md covering purpose, steps, shortcuts, error messages).
// ASSUMED naming (dispute if wrong): <screen> = helpKey suffix with "." -> "_" (lab.specimen.detail -> specimen_detail);
// help and manual use the SAME stem; §3.7 (history/trend) is a panel of the result grid, so it is covered in results.md;
// §3.8 is two screens (verify, approve = QueueScreen helpKey lab.verify / lab.approve); worksheet print = worksheet_print.
// Headings required in every page: Purpose, Steps, Shortcuts, Error messages (any level 2-3, case-insensitive).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const helpDir = join(root, 'apps/web/src/features/lab/help');
const manualDir = join(root, 'docs/manual/lab');
const comps = join(root, 'apps/web/src/features/lab/components');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);

// stem -> [route in manual, screen-specific copy from 04-UI-UX §3 that help AND manual must quote]
const SCREENS: Record<string, { route: string; copy: string[] }> = {
  labels: { route: '/lab/orders/{order_id}/labels', copy: [] },
  collect: { route: '/lab/collect', copy: [] },
  receive: { route: '/lab/receive', copy: [] },
  worklists: { route: '/lab/worklists', copy: [] },
  pending: { route: '/lab/pending', copy: [] },
  results: {
    route: '/lab/orders/{order_id}/results',
    copy: ['No previous results for this patient.', 'Not enough history to draw a trend (needs 2 results).', 'This item was changed by someone else. Reload to see the latest.'],
  },
  verify: {
    route: '/lab/verification',
    copy: ['Nothing waiting for verification.', 'Age unknown — reference range and critical check not applied'],
  },
  approve: { route: '/lab/approval', copy: ['Nothing waiting for approval.'] },
  critical_values: {
    route: '/lab/critical-values',
    copy: ['No critical values.', 'Notification recorded.', 'Entries cannot be edited or deleted.'],
  },
  ingest_exceptions: {
    route: '/lab/ingest-exceptions',
    copy: ['No open instrument exceptions.', 'This result is approved. To use the new value, a pathologist must amend it.'],
  },
  status_board: { route: '/lab/status-board', copy: ['No registrations in this period.'] },
  qc: { route: '/lab/qc', copy: ['No QC results captured.', 'QC results (captured — rules arrive with the QC module)'] },
  settings: { route: '/lab/settings', copy: ['Holds are created by the QC module'] },
  specimen_detail: { route: '/lab/specimens/{specimen_id}', copy: [] },
  worksheet_print: { route: '/lab/worksheets/{worksheet_id}', copy: ['snapshot; check the worklist for current status'] },
};
const stems = Object.keys(SCREENS).sort();
const COMMON_ERRORS = ["You don't have access to this screen.", 'Something went wrong'];
const HEADINGS = ['Purpose', 'Steps', 'Shortcuts', 'Error messages'];
const BANNED = [/\bTODO\b/, /\bTBD\b/, /\bFIXME\b/, /lorem ipsum/i, /\{\{|\}\}/, /<<<<<<<|>>>>>>>/];
const dirs: [string, string][] = [['help', helpDir], ['manual', manualDir]];
const pages = dirs.flatMap(([kind, d]) => stems.map((s) => [kind, s, join(d, `${s}.md`)] as const));

describe('C5.T-33 one page per screen (04-UI-UX §3, §6)', () => {
  it('covers 15 screens (§3.1-3.15 minus the §3.7 panel, with §3.8 split into verify/approve)', () => {
    expect(stems).toHaveLength(15);
  });
  it.each(pages)('%s/%s.md exists', (_k, _s, p) => {
    expect(existsSync(p), `missing ${p}`).toBe(true);
  });
  it.each(dirs)('%s dir has no orphan pages (every .md is a screen)', (_k, d) => {
    expect(mdIn(d).filter((n) => !stems.includes(n.replace(/\.md$/, '')))).toEqual([]);
  });
  it('every helpKey already passed to PageHeader in components has a help page', () => {
    const files = readdirSync(comps, { recursive: true, encoding: 'utf8' }).filter((n) => n.endsWith('.tsx'));
    const keys = new Set(files.flatMap((n) => [...read(join(comps, n)).matchAll(/helpKey="lab\.([a-z_.]+)"/g)].map((m) => m[1]!.replace(/\./g, '_'))));
    expect(keys.size).toBeGreaterThanOrEqual(8); // non-vacuous: collect, receive, qc, settings, ...
    for (const k of keys) expect(existsSync(join(helpDir, `${k}.md`)), `helpKey lab.${k} has no help/${k}.md`).toBe(true);
  });
});

describe('C5.T-33 doc lint: structure (04-UI-UX §6)', () => {
  it.each(pages)('%s/%s.md has title and Purpose/Steps/Shortcuts/Error messages', (_k, s, p) => {
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = read(p);
    expect(t.length, `${s} too short`).toBeGreaterThan(400);
    expect(t.match(/^#\s+\S/gm)).toHaveLength(1); // exactly one H1
    for (const h of HEADINGS) expect(t, `${p} needs a "${h}" heading`).toMatch(new RegExp(`^#{2,3}\\s+.*${h}`, 'im'));
  });
  it.each(pages)('%s/%s.md: each section is non-empty', (_k, _s, p) => {
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const parts = read(p).split(/^#{2,3}\s+/m).slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(4);
    for (const part of parts) expect(part.split(/\r?\n/).slice(1).join('').trim().length, `empty section "${part.split(/\r?\n/)[0]}"`).toBeGreaterThan(10);
  });
  it.each(pages)('%s/%s.md: no placeholders or merge markers; no relative-link rot', (_k, _s, p) => {
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = read(p);
    for (const re of BANNED) expect(t, `${p}: ${re}`).not.toMatch(re);
    for (const m of t.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)[^)]*\)/g)) expect(existsSync(resolve(dirname(p), m[1]!)), `${p}: broken link ${m[1]}`).toBe(true);
  });
});

describe('C5.T-33 content: copy comes from the spec, verbatim', () => {
  it.each(pages)('%s/%s.md quotes the common error copy', (_k, _s, p) => {
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = read(p);
    for (const c of COMMON_ERRORS) expect(t, `${p} missing "${c}"`).toContain(c);
  });
  it.each(pages)('%s/%s.md quotes its screen-specific copy', (_k, s, p) => {
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = read(p);
    for (const c of SCREENS[s]!.copy) expect(t, `${p} missing "${c}"`).toContain(c);
  });
  it.each(stems)('manual/%s.md states the screen route', (s) => {
    const p = join(manualDir, `${s}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    expect(read(p), `${p} must name ${SCREENS[s]!.route}`).toContain(SCREENS[s]!.route);
  });
  it('results help + manual document the history drawer and trend dialog (§3.7)', () => {
    for (const d of [helpDir, manualDir]) {
      const p = join(d, 'results.md');
      expect(existsSync(p), `missing ${p}`).toBe(true);
      const t = read(p);
      expect(t).toMatch(/history/i);
      expect(t).toMatch(/trend/i);
      expect(t).toContain('Show as table');
    }
  });
  it('verify/approve document Shift+Down bulk selection (§3.8)', () => {
    for (const s of ['verify', 'approve']) for (const d of [helpDir, manualDir]) {
      const p = join(d, `${s}.md`);
      expect(existsSync(p), `missing ${p}`).toBe(true);
      expect(read(p)).toMatch(/Shift\s*\+\s*(↓|Down)/i);
    }
  });
  it('status board documents the 30 s auto-refresh and pause toggle (§3.11)', () => {
    for (const d of [helpDir, manualDir]) {
      const p = join(d, 'status_board.md');
      expect(existsSync(p), `missing ${p}`).toBe(true);
      expect(read(p)).toMatch(/30\s*(s|sec)/i);
      expect(read(p)).toMatch(/pause/i);
    }
  });
  it('synthetic-data rule: no emails or 10-digit phone numbers in any page', () => {
    expect(pages.filter(([, , p]) => existsSync(p))).toHaveLength(pages.length); // fails until all exist
    for (const [, , p] of pages) {
      const t = read(p);
      expect(t, p).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(t, p).not.toMatch(/\b\d{10}\b/);
    }
  });
});
