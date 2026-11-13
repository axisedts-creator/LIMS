// @vitest-environment jsdom
// T0D-UI-R03 (LD-140, spec/program/10-DESIGN-SYSTEM.md §2.3-2.4, §3-4, §6, §8): kit pass.
// Radius ladder 8/12/16/20/full, green-tinted elevation 1 on resting surfaces only, hairline OR elevation, comfortable + compact density,
// every status = tone + icon + word, no colour/radius literals in components, stories + recorded snapshots.
//
// CONTRACT chosen here where the spec gives no API (implementer: follow it, or file a dispute):
//   StatusChip / FlagBadge / StatTile delta / StatusStepper step / PermissionMatrix "Privileged": an aria-hidden <svg> from <Icon> (distinct path per tone) + the word.
//   DataTable: density 'compact' | 'regular'(default) | 'comfortable'; new props
//     rowStatus?: (row) => StatusChipProps | undefined  -> a visible "Status" column with a StatusChip; <tr data-tone="<tone>">
//     bulkActions?: {id,label,isDanger?}[]; onBulkAction?: (actionId, selectedIds) => void
//       -> when selection.selectedIds is non-empty: role=toolbar "Bulk actions" with "N selected", one button per action, and a "Clear selection" button.
//   Tabs: item.count?: number (0 is shown) next to the label in the tab's accessible name; `badge` keeps working.
//   Drawer.tsx also exports DrawerSection { title, onSave, isSaving?, children }: <section> (role region, name = title), <h3>, own Save button.
//   Stories (axe-checked here): DataTable.{BulkSelected,Compact,RowStatus} Drawer.Sections Tabs.WithCounts StatusChip.AllTones.
//   Snapshots (`__snapshots__/ui-r03-kit-pass.test.tsx.snap`) are recorded by the implementer: `vitest run -u` on this file once everything else passes.
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEVANAGARI, seriousViolations, user, XSS } from './helpers';
import { StatusChip, statusOf } from '../StatusChip/StatusChip';
import { FlagBadge } from '../FlagBadge/FlagBadge';
import { StatTile } from '../StatTile/StatTile';
import { DataTable, type ColumnDef } from '../DataTable/DataTable';
import { Tabs } from '../Tabs/Tabs';
import * as DrawerMod from '../Drawer/Drawer';
import { PageShell } from '../PageShell/PageShell';
import { PermissionMatrix } from '../PermissionMatrix/PermissionMatrix';
import { StatusStepper } from '../StatusStepper/StatusStepper';

const Drawer = DrawerMod.Drawer;
const DrawerSection: any = (DrawerMod as any).DrawerSection;
const loose = (o: object) => o as any; // props this task adds; tests are not type-checked (tsconfig excludes __tests__)

// ---------------------------------------------------------------- tiny CSS reader
type Rule = { sels: string[]; decls: Map<string, string>; media: string };
function parseCss(src: string): Rule[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const media: string[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    const close = s.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      media.pop();
      i = close + 1;
      continue;
    }
    const prelude = s.slice(i, open).trim();
    if (/^@(media|supports)/.test(prelude)) {
      media.push(prelude);
      i = open + 1;
      continue;
    }
    if (prelude.startsWith('@')) {
      let depth = 1;
      let j = open + 1;
      while (depth && j < s.length) depth += s[j] === '{' ? 1 : s[j] === '}' ? -1 : 0, j++;
      i = j;
      continue;
    }
    const end = s.indexOf('}', open);
    const decls = new Map<string, string>();
    for (const d of s.slice(open + 1, end).split(';')) {
      const k = d.indexOf(':');
      if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim());
    }
    out.push({ sels: prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), decls, media: media.join(' ') });
    i = end + 1;
  }
  return out;
}

const COMPONENTS = join(process.cwd(), 'src', 'components'); // vitest root = packages/ui (jsdom import.meta.url is not a file: URL)
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const files = walk(COMPONENTS);
const cssFiles = files.filter((f) => f.endsWith('.css'));
const prodCode = files.filter((f) => /\.tsx?$/.test(f) && !/\.stories\.tsx?$/.test(f));
const kitCss = readFileSync(join(COMPONENTS, 'kit.css'), 'utf8');
const rules = parseCss(kitCss);

/** Last value of `prop` over rules whose selector list contains exactly `sel` (no media). */
const decl = (sel: string, prop: string) => rules.filter((r) => !r.media && r.sels.includes(sel) && r.decls.has(prop)).at(-1)?.decls.get(prop);
const radiusDecl = (sel: string) =>
  rules
    .filter((r) => !r.media && r.sels.includes(sel))
    .flatMap((r) => [...r.decls].filter(([k]) => /^border(-[a-z]+)*-radius$/.test(k)).map(([, v]) => v))
    .at(-1);
const px = (v: string | undefined) => (v && /^(\d+(?:\.\d+)?)px$/.exec(v)?.[1] ? Number(/^(\d+(?:\.\d+)?)px$/.exec(v)![1]) : NaN);
const withHover = (base: string) => rules.filter((r) => r.sels.some((s) => s.includes(base) && /:hover|\[data-hovered/.test(s)));

// ---------------------------------------------------------------- 1. literals, ladder, elevation, sizes (static)
describe('no colour or radius literals inside components (10-DESIGN-SYSTEM §8, LD-140)', () => {
  // BarcodeSymbol: a scannable symbol must be pure black on white whatever the theme; not a design colour.
  const prod = prodCode.filter((f) => !/BarcodeSymbol/.test(f));
  const COLOUR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
  it('kit.css and component css: no hex, rgb()/hsl()/oklch() literal', () => {
    const bad = cssFiles.flatMap((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l) || COLOUR_FN.test(l)).map((l) => `${f.slice(COMPONENTS.length)}: ${l.trim()}`));
    expect(bad).toEqual([]);
  });
  it('component code: no colour string/function literal (hex, rgb(), hsl()...) and no pixel radius', () => {
    const bad = prod.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /['"`]#[0-9a-fA-F]{3,8}['"`]/.test(l) || COLOUR_FN.test(l) || /borderRadius|border-radius/.test(l))
        .map((l) => `${f.slice(COMPONENTS.length)}: ${l.trim()}`),
    );
    expect(bad).toEqual([]);
  });
  it('every border-radius in css is 0/inherit or a --lims-radius-* token (never px/rem)', () => {
    const vals = rules.flatMap((r) => [...r.decls].filter(([k]) => /^border(-[a-z]+)*-radius$/.test(k)).map(([, v]) => v));
    expect(vals.length).toBeGreaterThan(10);
    expect(vals.filter((v) => !/^(0|inherit|(var\(--lims-radius-(sm|md|lg|xl|full)\)\s*)+)$/.test(v))).toEqual([]);
  });
  it('no gradient, glass or glow in components (§6)', () => {
    const bad = [...cssFiles, ...prod].filter((f) => /gradient\(|backdrop-filter|\bblur\(/i.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});

describe('radius ladder 8/12/16/20/full (§2.3)', () => {
  // selector -> token. sm: checkboxes, dense chips; md: inputs, buttons, menu items; lg: cards, panels; xl: dialogs, drawers; full: pills.
  const LADDER: [string, string][] = [
    ['.lims-check-box', 'sm'],
    ['.lims-btn', 'md'],
    ['.lims-input', 'md'],
    ['.lims-menuitem', 'md'],
    ['.lims-card', 'lg'],
    ['.lims-stat', 'lg'],
    ['.lims-popover', 'lg'],
    ['.lims-dialog', 'xl'],
    ['.lims-drawer', 'xl'],
    ['.lims-chip', 'full'],
    ['.lims-tab-badge', 'full'],
  ];
  it.each(LADDER)('%s uses --lims-radius-%s', (sel, token) => {
    expect(radiusDecl(sel), `${sel} has no border-radius`).toContain(`var(--lims-radius-${token})`);
  });
});

describe('elevation: green-tinted level 1 on resting surfaces only; hairline OR shadow (§2.3, §6)', () => {
  it('every box-shadow in kit.css is none or an --lims-elevation-N token (no literal shadows, so no glow)', () => {
    const vals = rules.map((r) => r.decls.get('box-shadow')).filter(Boolean) as string[];
    expect(vals.length).toBeGreaterThan(2);
    expect(vals.filter((v) => !/^(none|var\(--lims-elevation-[0-3]\))$/.test(v))).toEqual([]);
  });
  it.each(['.lims-card', '.lims-stat', '.lims-data-table', '.lims-shell-top'])('%s (resting) never uses elevation 2 or 3', (sel) => {
    expect(decl(sel, 'box-shadow') ?? 'none').toMatch(/^(none|var\(--lims-elevation-[01]\))$/);
  });
  it.each(['.lims-card', '.lims-stat'])('%s has a hairline border or elevation 1, never both', (sel) => {
    const border = decl(sel, 'border');
    const hairline = !!border && !/^(0|none)\b/.test(border);
    const shadow = /elevation-1/.test(decl(sel, 'box-shadow') ?? '');
    expect(hairline && shadow, `${sel}: border "${border}" + shadow "${decl(sel, 'box-shadow')}"`).toBe(false);
    expect(hairline || shadow, `${sel} has neither border nor elevation 1`).toBe(true);
  });
  it('floating layers keep their higher levels: popover/toast >= 2, dialog/drawer = 3', () => {
    expect(decl('.lims-popover', 'box-shadow')).toMatch(/elevation-[23]/);
    expect(decl('.lims-dialog', 'box-shadow')).toMatch(/elevation-3/);
    expect(decl('.lims-drawer', 'box-shadow')).toMatch(/elevation-3/);
  });
});

describe('control size, density, sticky header, shell metrics (§2.3, §2.4, §3)', () => {
  it.each(['.lims-btn', '.lims-input'])('%s min-height is 40 (desktop control height)', (sel) => {
    expect(px(decl(sel, 'min-height'))).toBeGreaterThanOrEqual(40);
  });
  it.each([['compact', 32], ['regular', 40], ['comfortable', 48]] as const)('table density %s: row min-height %ipx', (d, h) => {
    const r = rules.filter((x) => x.sels.some((s) => s.includes(`.lims-table-${d}`)) && x.decls.has('min-height'));
    expect(r.map((x) => px(x.decls.get('min-height')))).toContain(h);
  });
  it('sticky header: position sticky, top 0, above rows (z-index token), opaque background', () => {
    const r = rules.filter((x) => x.sels.some((s) => s.includes('.lims-table-sticky') && /th|thead/.test(s)));
    const d = (p: string) => r.find((x) => x.decls.has(p))?.decls.get(p);
    expect(d('position')).toBe('sticky');
    expect(d('top')).toMatch(/^0(px)?$/);
    expect(d('z-index')).toBe('var(--lims-z-sticky)');
    expect(d('background')).toMatch(/var\(--lims-neutral-(0|50)\)/);
  });
  it('rail 248, top bar 56, flat neutral.50 page', () => {
    expect(px(decl('.lims-shell-nav', 'width'))).toBe(248);
    expect(px(decl('.lims-shell-top', 'min-height'))).toBe(56);
    expect([decl('.lims-shell', 'background'), decl('.lims-shell-body', 'background'), decl('.lims-shell-main', 'background')].join(' ')).toContain('var(--lims-neutral-50)');
  });
  it('numbers in tab counts, stat values and tables are tabular', () => {
    expect(decl('.lims-tab-badge', 'font-variant-numeric')).toBe('tabular-nums');
    expect(decl('.lims-stat-value', 'font-variant-numeric')).toBe('tabular-nums');
  });
});

describe('interactive states (task title: states)', () => {
  it.each(['.lims-btn', '.lims-tab', '.lims-row'])('%s has a hover state', (base) => {
    expect(withHover(base).length, `no :hover / [data-hovered] rule for ${base}`).toBeGreaterThan(0);
  });
  it('primary button hover uses accent.hover; disabled and focus-visible stay defined', () => {
    expect(withHover('.lims-btn-primary').some((r) => (r.decls.get('background') ?? '').includes('--lims-accent-hover'))).toBe(true);
    expect(decl('.lims-btn[data-disabled]', 'cursor')).toBe('not-allowed');
    expect(kitCss).toMatch(/:focus-visible[^{]*{[^}]*outline:[^;}]*var\(--lims-focus-ring\)/);
  });
  it('a selected table row is tinted with an accent token (row status never colour alone: chip carries tone + icon + word)', () => {
    const r = rules.filter((x) => x.sels.some((s) => s.includes('.lims-row') && /\[data-selected|\[aria-selected/.test(s)));
    expect(r.some((x) => /var\(--lims-accent-(subtle|highlight)\)/.test(x.decls.get('background') ?? ''))).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. status = tone + icon + word
const iconD = (el: Element | null) => el?.querySelector('svg path')?.getAttribute('d') ?? '';
const TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'critical'] as const;
const KINDS: Record<string, string[]> = {
  specimen: ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'],
  result: ['pending', 'resulted', 'verified', 'approved', 'cancelled', 'on_hold', 'qc_review_required'],
  report_version: ['rendering', 'rendered', 'render_failed', 'released', 'superseded', 'discarded'],
  order: ['pre_registered', 'registered', 'in_progress', 'completed', 'cancelled'],
  invoice: ['issued', 'cancelled'],
  payment_intent: ['created', 'initiated', 'pending', 'settled', 'failed', 'expired', 'held_for_review', 'refunded', 'partially_refunded'],
  dead_letter: ['open', 'replayed', 'discarded'],
};

describe('StatusChip: tone + icon + word (§6 "colour-only status")', () => {
  const all = Object.entries(KINDS).flatMap(([kind, ss]) => ss.map((s) => [kind, s] as const));
  it('covers every kind/status the chip maps (guard against a stale list)', () => {
    expect(all.length).toBe(46);
    for (const [k, s] of all) expect(statusOf(k, s)[1], `${k}.${s}`).not.toBe(s);
  });
  it.each(all)('%s.%s shows an icon and its word, in its tone', (kind, status) => {
    const [tone, word] = statusOf(kind, status);
    const { container } = render(<StatusChip kind={kind as any} status={status} />);
    const chip = container.querySelector('.lims-chip')!;
    expect(chip.getAttribute('data-tone')).toBe(tone);
    expect(chip.textContent?.trim()).toBe(word);
    expect(chip.querySelectorAll('svg').length, 'icon').toBe(1);
    expect(chip.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });
  it('unknown status code still gets icon + word (neutral)', () => {
    const { container } = render(<StatusChip kind="specimen" status="not_a_status" />);
    expect(container.querySelector('.lims-chip svg')).toBeTruthy();
    expect(container.textContent).toBe('not_a_status');
  });
  it('the six tones have six different icons (a colour-blind reader can still tell them apart)', () => {
    const ds = TONES.map((t) => iconD(render(<StatusChip kind="generic" status="x" tone={t} label={`W-${t}`} />).container));
    expect(ds.every(Boolean)).toBe(true);
    expect(new Set(ds).size).toBe(6);
  });
  it('size sm keeps icon + word; Devanagari label intact; markup in label stays text', () => {
    const { container } = render(<StatusChip kind="generic" status="x" tone="success" label={DEVANAGARI} size="sm" />);
    expect(container.textContent).toBe(DEVANAGARI);
    expect(container.querySelector('svg')).toBeTruthy();
    for (const x of XSS) {
      const r = render(<StatusChip kind="generic" status="x" tone="danger" label={x} />);
      expect(r.container.textContent).toBe(x);
      expect(r.container.querySelector('img,script,svg[onload]')).toBeNull();
      expect(r.container.querySelectorAll('svg')).toHaveLength(1);
      r.unmount();
    }
  });
});

describe('FlagBadge: tone + icon + word', () => {
  it.each([['L', 'Low', 'danger'], ['H', 'High', 'danger'], ['LL', 'Critical low', 'critical'], ['HH', 'Critical high', 'critical'], ['A', 'Abnormal', 'danger'], ['N', 'Normal', 'neutral']] as const)('%s -> icon + "%s" (%s)', (flag, word, tone) => {
    const { container } = render(<FlagBadge flag={flag} showNormal />);
    const chip = container.querySelector('.lims-chip')!;
    expect(chip.getAttribute('data-tone')).toBe(tone);
    expect(chip.textContent?.trim()).toBe(word);
    expect(chip.querySelectorAll('svg')).toHaveLength(1);
  });
  it('N is hidden unless showNormal; unknown flag renders nothing', () => {
    expect(render(<FlagBadge flag="N" />).container.innerHTML).toBe('');
    expect(render(<FlagBadge flag={'ZZ' as any} />).container.innerHTML).toBe('');
  });
});

describe('StatTile delta: tone + icon + word, one icon family', () => {
  it.each([['up', true, 'success'], ['down', false, 'danger'], ['flat', undefined, 'neutral']] as const)('delta %s', (direction, isGood, tone) => {
    const { container } = render(<StatTile label="TAT" value="42 min" delta={{ value: '5%', direction, ...(isGood === undefined ? {} : { isGood }) }} />);
    const d = container.querySelector('.lims-stat-delta')!;
    expect(d.getAttribute('data-tone')).toBe(tone);
    expect(d.querySelectorAll('svg').length, 'svg icon').toBe(1);
    expect(d.textContent).not.toMatch(/[▲▼▬△▽]/); // text glyphs are a second icon family (§6)
    expect(d.textContent).toMatch(direction === 'flat' ? /no change/i : direction === 'up' ? /\bup\b/i : /\bdown\b/i);
    expect(d.textContent).toContain('5%');
  });
  it('href safety unchanged: only an app-relative path becomes a link (REQ-SEC-088)', () => {
    for (const h of ['javascript:alert(1)', '//evil.example/x', 'https://evil.example/', 'data:text/html,x']) {
      const r = render(<StatTile label="X" value="1" href={h} />);
      expect(r.container.querySelector('a'), h).toBeNull();
      r.unmount();
    }
    const ok = render(<StatTile label="X" value="1" href="/lab/reports" />);
    expect(ok.container.querySelector('a')?.getAttribute('href')).toBe('/lab/reports');
  });
});

describe('StatusStepper: tone + icon + word per step', () => {
  const steps = ['Uploaded', 'Scan', 'Validate', 'Commit'].map((label, i) => ({ id: `s${i}`, label }));
  it('every step has one icon and its state word; done/current/upcoming/failed icons all differ', () => {
    const ok = render(<StatusStepper steps={steps} currentId="s1" />);
    const li = [...ok.container.querySelectorAll('li')];
    expect(li.every((x) => x.querySelectorAll('svg').length === 1)).toBe(true);
    const [done, cur, up] = [iconD(li[0]!), iconD(li[1]!), iconD(li[2]!)];
    ok.unmount();
    const bad = render(<StatusStepper steps={steps} currentId="s1" outcome={{ kind: 'failed', label: 'Scan failed' }} />);
    const failed = iconD(bad.container.querySelectorAll('li')[1]!);
    expect(new Set([done, cur, up, failed]).size).toBe(4);
    expect(bad.container.querySelectorAll('li')[1]!.textContent).toMatch(/failed/i);
    expect(bad.container.querySelector('[role="alert"]')?.textContent).toContain('Scan failed');
  });
  it('tone per state stays: done success, current info, failed danger, upcoming neutral', () => {
    const { container } = render(<StatusStepper steps={steps} currentId="s1" />);
    expect([...container.querySelectorAll('li')].map((x) => x.getAttribute('data-tone'))).toEqual(['success', 'info', 'neutral', 'neutral']);
  });
});

describe('PermissionMatrix: Privileged is tone + icon + word; keyboard unchanged', () => {
  const modules = [{ id: 'm1', label: 'Orders' }, { id: 'm2', label: 'Reports' }];
  const permissions = [
    { code: 'order.read', moduleId: 'm1', resource: 'order' },
    { code: 'order.void', moduleId: 'm1', resource: 'order', isPrivileged: true },
    { code: 'report.release', moduleId: 'm2', resource: 'report', isPrivileged: true },
  ];
  it('Privileged chip has an icon and the word', () => {
    render(<PermissionMatrix label="Role" modules={modules} permissions={permissions} value={['order.read']} onChange={() => {}} />);
    const chips = screen.getAllByText('Privileged').map((e) => e.closest('.lims-chip')!);
    expect(chips).toHaveLength(2);
    for (const c of chips) {
      expect(c.getAttribute('data-tone')).toBe('warning');
      expect(c.querySelectorAll('svg')).toHaveLength(1);
    }
  });
  it('one tab stop; ArrowRight moves to the next code, Space toggles', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<PermissionMatrix label="Role" modules={modules} permissions={permissions} value={[]} onChange={onChange} />);
    screen.getByRole('checkbox', { name: /order\.read/ }).focus();
    await u.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: /order\.void/ }));
    await u.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(['order.void']);
  });
});

// ---------------------------------------------------------------- 3. DataTable: row status, density, bulk bar
type R = { id: string; name: string; state: string };
const rows: R[] = [
  { id: 'r1', name: 'Alpha', state: 'rejected' },
  { id: 'r2', name: 'Bravo', state: 'approved' },
  { id: 'r3', name: 'Charlie', state: 'collected' },
];
const columns: ColumnDef<R>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, isRowHeader: true },
  { id: 'state', header: 'State', cell: (r) => r.state },
];
const base = { caption: 'Specimens', columns, rows, getRowId: (r: R) => r.id, emptyState: { title: 'No specimens yet' } };
const sel = (ids: string[], onChange = vi.fn()) => ({ mode: 'multiple' as const, selectedIds: new Set(ids), onChange });
const rowStatus = (r: R) => ({ kind: 'specimen' as const, status: r.state });
const bulkActions = [{ id: 'export', label: 'Export' }, { id: 'void', label: 'Void', isDanger: true }];

describe('DataTable density, sticky header', () => {
  it.each([['compact'], ['regular'], ['comfortable']])('density %s sets lims-table-%s', (d) => {
    const { container } = render(<DataTable {...base} density={d as any} />);
    expect(container.querySelector(`.lims-table.lims-table-${d}`)).toBeTruthy();
  });
  it('default density is regular; header is sticky by default and not when stickyHeader=false', () => {
    const a = render(<DataTable {...base} />);
    expect(a.container.querySelector('.lims-table-regular.lims-table-sticky')).toBeTruthy();
    a.unmount();
    expect(render(<DataTable {...base} stickyHeader={false} />).container.querySelector('.lims-table-sticky')).toBeNull();
  });
});

describe('DataTable row status', () => {
  it('each row has a StatusChip (icon + word) in a "Status" column, and data-tone on the row', () => {
    const { container } = render(<DataTable {...base} {...loose({ rowStatus })} />);
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeTruthy();
    const trs = [...container.querySelectorAll('[data-row-id]')];
    expect(trs).toHaveLength(3);
    const expected = rows.map((r) => statusOf('specimen', r.state));
    trs.forEach((tr, i) => {
      const chip = tr.querySelector('.lims-chip')!;
      expect(chip, `row ${i} chip`).toBeTruthy();
      expect(chip.textContent?.trim()).toBe(expected[i]![1]);
      expect(chip.querySelectorAll('svg')).toHaveLength(1);
      expect(tr.getAttribute('data-tone')).toBe(expected[i]![0]);
    });
  });
  it('rowStatus returning undefined for a row leaves that row without a chip; no rowStatus = no Status column', () => {
    const { container } = render(<DataTable {...base} {...loose({ rowStatus: (r: R) => (r.id === 'r2' ? undefined : rowStatus(r)) })} />);
    expect(container.querySelectorAll('.lims-chip')).toHaveLength(2);
    expect(container.querySelector('[data-row-id="r2"]')!.hasAttribute('data-tone')).toBe(false);
    document.body.innerHTML = '';
    render(<DataTable {...base} />);
    expect(screen.queryByRole('columnheader', { name: /status/i })).toBeNull();
  });
  it('status label that is markup stays text', () => {
    const { container } = render(<DataTable {...base} {...loose({ rowStatus: () => ({ kind: 'generic', status: 'x', tone: 'danger', label: XSS[0] }) })} />);
    expect(container.querySelector('img,script')).toBeNull();
    expect(container.textContent).toContain(XSS[0]);
  });
});

describe('DataTable bulk bar', () => {
  const props = (ids: string[], extra: object = {}) => ({ ...base, selection: sel(ids), ...loose({ bulkActions, onBulkAction: vi.fn(), ...extra }) });
  it('absent with nothing selected; present with a selection, named, with the count and the actions', () => {
    const none = render(<DataTable {...props([])} />);
    expect(screen.queryByRole('toolbar', { name: /bulk/i })).toBeNull();
    none.unmount();
    render(<DataTable {...props(['r1', 'r2'])} />);
    const bar = screen.getByRole('toolbar', { name: /bulk/i });
    expect(within(bar).getByText(/2 selected/i)).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Export' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Void' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: /clear selection/i })).toBeTruthy();
  });
  it('bar goes away when the selection is emptied (rerender)', () => {
    const p = props(['r1']);
    const { rerender } = render(<DataTable {...p} />);
    expect(screen.getByRole('toolbar', { name: /bulk/i })).toBeTruthy();
    rerender(<DataTable {...p} selection={sel([])} />);
    expect(screen.queryByRole('toolbar', { name: /bulk/i })).toBeNull();
  });
  it('an action receives its id and the selected ids; Clear selection empties the selection', async () => {
    const onBulkAction = vi.fn();
    const onChange = vi.fn();
    const u = user();
    render(<DataTable {...base} selection={sel(['r1', 'r3'], onChange)} {...loose({ bulkActions, onBulkAction })} />);
    await u.click(screen.getByRole('button', { name: 'Export' }));
    expect(onBulkAction).toHaveBeenCalledTimes(1);
    expect(onBulkAction.mock.calls[0]![0]).toBe('export');
    expect([...onBulkAction.mock.calls[0]![1]].sort()).toEqual(['r1', 'r3']);
    await u.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].size).toBe(0);
  });
  it('keyboard: the bulk actions are tab-reachable and Enter runs them', async () => {
    const onBulkAction = vi.fn();
    const u = user();
    render(<DataTable {...base} selection={sel(['r2'])} {...loose({ bulkActions, onBulkAction })} />);
    const target = screen.getByRole('button', { name: 'Void' });
    for (let i = 0; i < 40 && document.activeElement !== target; i++) await u.tab();
    expect(document.activeElement).toBe(target);
    await u.keyboard('{Enter}');
    expect(onBulkAction.mock.calls[0]![0]).toBe('void');
    expect([...onBulkAction.mock.calls[0]![1]]).toEqual(['r2']);
  });
  it('selection.max (CV §4.1 bulk cap) is still enforced: select-all over the cap is refused', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<DataTable {...base} selection={{ ...sel([], onChange), max: 2 }} />); // 3 rows, cap 2
    await u.click(screen.getAllByRole('checkbox')[0]!); // select-all
    for (const c of onChange.mock.calls) expect(c[0].size).toBeLessThanOrEqual(2);
  });
  it('labels that are markup are text; Devanagari action label intact', () => {
    render(<DataTable {...props(['r1'], { bulkActions: [{ id: 'a', label: XSS[0] }, { id: 'b', label: DEVANAGARI }] })} />);
    const bar = screen.getByRole('toolbar', { name: /bulk/i });
    expect(bar.querySelector('img,script')).toBeNull();
    expect(within(bar).getByRole('button', { name: DEVANAGARI })).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 4. Tabs with counts
describe('Tabs with counts', () => {
  const items = [{ id: 'a', label: 'To collect', count: 12 }, { id: 'b', label: 'To receive', count: 0 }, { id: 'c', label: 'Hold' }, { id: 'd', label: 'Rejected', badge: '!' }];
  it('count is part of the tab name and shown in a pill; 0 is shown; no count = no pill; badge still works', () => {
    render(<Tabs items={loose(items)} selectedId="a" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: /To collect\D*12\b/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /To receive\D*0\b/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Hold' }).querySelector('.lims-tab-badge')).toBeNull();
    expect(screen.getByRole('tab', { name: /Rejected/ }).textContent).toContain('!');
    expect(screen.getByRole('tab', { name: /To collect/ }).querySelector('.lims-tab-badge')?.textContent).toBe('12');
  });
  it('keyboard: ArrowRight/End move selection through counted tabs; selected tab is aria-selected', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<Tabs items={loose(items)} selectedId="a" onChange={onChange} />);
    screen.getByRole('tab', { name: /To collect/ }).focus();
    await u.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('b');
    await u.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('d');
  });
  it('Devanagari label + count intact', () => {
    render(<Tabs items={loose([{ id: 'a', label: DEVANAGARI, count: 3 }])} selectedId="a" onChange={() => {}} />);
    expect(screen.getByRole('tab').textContent).toContain(DEVANAGARI);
  });
});

// ---------------------------------------------------------------- 5. Drawer sections with per-section Save
describe('Drawer sections with per-section Save', () => {
  const mount = (a = vi.fn(), b = vi.fn(), extra: object = {}, onClose = vi.fn()) =>
    render(
      <Drawer title="Centre" isOpen onClose={onClose}>
        <DrawerSection title="Contact" onSave={a} {...extra}><p>phone</p></DrawerSection>
        <DrawerSection title="Billing" onSave={b}><p>currency</p></DrawerSection>
      </Drawer>,
    );
  it('Drawer.tsx exports DrawerSection', () => {
    expect(typeof DrawerSection).toBe('function');
  });
  it('each section is a named region with an h3; each has its own Save, with names that differ', () => {
    mount();
    for (const t of ['Contact', 'Billing']) {
      const region = screen.getByRole('region', { name: t });
      expect(within(region).getByRole('heading', { name: t, level: 3 })).toBeTruthy();
      expect(within(region).getAllByRole('button', { name: /save/i })).toHaveLength(1);
    }
    const names = screen.getAllByRole('button', { name: /save/i }).map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(new Set(names).size).toBe(2);
    expect(screen.getByRole('heading', { name: 'Centre', level: 2 })).toBeTruthy();
  });
  it('pressing one Save calls only that section\'s onSave', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const u = user();
    mount(a, b);
    await u.click(within(screen.getByRole('region', { name: 'Billing' })).getByRole('button', { name: /save/i }));
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });
  it('keyboard: Tab reaches the second Save and Enter runs only it; Escape closes the drawer', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const onClose = vi.fn();
    const u = user();
    mount(a, b, {}, onClose);
    const target = within(screen.getByRole('region', { name: 'Billing' })).getByRole('button', { name: /save/i });
    for (let i = 0; i < 30 && document.activeElement !== target; i++) await u.tab();
    expect(document.activeElement).toBe(target);
    await u.keyboard('{Enter}');
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    await u.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
  it('isSaving: that Save is disabled, says Saving, and a press does nothing', async () => {
    const a = vi.fn();
    const u = user();
    mount(a, vi.fn(), { isSaving: true });
    const region = screen.getByRole('region', { name: 'Contact' });
    const btn = within(region).getByRole('button', { name: /sav/i }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(within(region).getByText(/saving/i)).toBeTruthy();
    await u.click(btn);
    expect(a).not.toHaveBeenCalled();
    expect(within(screen.getByRole('region', { name: 'Billing' })).getByRole('button', { name: /save/i }).hasAttribute('disabled')).toBe(false);
  });
  it('markup / Devanagari in a section title is text', () => {
    render(
      <Drawer title="X" isOpen onClose={() => {}}>
        <DrawerSection title={XSS[0]} onSave={() => {}}>c</DrawerSection>
        <DrawerSection title={DEVANAGARI} onSave={() => {}}>c</DrawerSection>
      </Drawer>,
    );
    expect(document.querySelector('img[onerror],script')).toBeNull();
    expect(screen.getByRole('region', { name: DEVANAGARI })).toBeTruthy();
  });
  it('axe: zero serious/critical', async () => {
    mount();
    await act(async () => {});
    expect(await seriousViolations(document.body)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 6. PageShell
describe('PageShell', () => {
  it('landmarks kept; skip link is the first tab stop and targets <main>', async () => {
    const u = user();
    render(<PageShell topBar={<span>top</span>} nav={<a href="#o">Orders</a>}>body</PageShell>);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    const main = screen.getByRole('main');
    await u.tab();
    const skip = document.activeElement as HTMLAnchorElement;
    expect(skip.textContent).toMatch(/skip to main/i);
    expect(skip.getAttribute('href')).toBe(`#${main.id}`);
  });
});

// ---------------------------------------------------------------- 7. stories + axe on the new ones
const storyMods = import.meta.glob('../*/*.stories.tsx', { eager: true }) as Record<string, any>;
const NEW_STORIES: [string, string][] = [['DataTable', 'BulkSelected'], ['DataTable', 'Compact'], ['DataTable', 'RowStatus'], ['Drawer', 'Sections'], ['Tabs', 'WithCounts'], ['StatusChip', 'AllTones']];
const toElement = (meta: any, story: any) => {
  const args = { ...(meta?.args ?? {}), ...(story?.args ?? {}) };
  if (typeof story === 'function') return createElement(story);
  if (typeof story?.render === 'function') return createElement(() => story.render(args));
  return createElement(meta.component, args);
};
describe('stories updated (done_when) and axe-clean', () => {
  it.each(NEW_STORIES)('%s has story %s', (c, s) => {
    expect(storyMods[`../${c}/${c}.stories.tsx`]?.[s], `${c}.stories.tsx must export ${s}`).toBeTruthy();
  });
  it.each(NEW_STORIES)('axe zero serious/critical: %s/%s', async (c, s) => {
    const mod = storyMods[`../${c}/${c}.stories.tsx`];
    expect(mod?.[s]).toBeTruthy();
    render(toElement(mod.default, mod[s]));
    await act(async () => {});
    expect(await seriousViolations(document.body)).toEqual([]);
  });
  it('AllTones story shows all six tones', () => {
    const mod = storyMods['../StatusChip/StatusChip.stories.tsx'];
    expect(mod?.AllTones).toBeTruthy();
    const { container } = render(toElement(mod.default, mod.AllTones));
    expect(new Set([...container.querySelectorAll('.lims-chip')].map((c) => c.getAttribute('data-tone')))).toEqual(new Set(TONES));
  });
});

// ---------------------------------------------------------------- 8. recorded visual snapshots of the kit
function norm(html: string) {
  const seen = new Map<string, string>();
  const tag = (v: string) => v.split(/\s+/).map((x) => seen.get(x) ?? (seen.set(x, `#${seen.size + 1}`), seen.get(x)!)).join(' ');
  return html.replace(/(?<![-\w])(id|for|aria-labelledby|aria-describedby|aria-controls|aria-owns)="([^"]*)"/g, (_m, a, v) => `${a}="${tag(v)}"`);
}
const snap = () => norm(document.body.innerHTML);

describe('UI-R03 kit snapshots', () => {
  it('StatusChip: all tones, both sizes', () => {
    render(<>{TONES.map((t) => <StatusChip key={t} kind="generic" status="x" tone={t} label={`Tone ${t}`} />)}<StatusChip kind="specimen" status="rejected" size="sm" /></>);
    expect(snap()).toMatchSnapshot();
  });
  it('FlagBadge: every flag', () => {
    render(<>{(['N', 'L', 'H', 'LL', 'HH', 'A'] as const).map((f) => <FlagBadge key={f} flag={f} showNormal />)}</>);
    expect(snap()).toMatchSnapshot();
  });
  it('StatTile: plain, delta good, delta bad, link', () => {
    render(<><StatTile label="A" value="1" /><StatTile label="B" value="2" delta={{ value: '3%', direction: 'up', isGood: true }} /><StatTile label="C" value="3" delta={{ value: '4%', direction: 'down', isGood: false }} /><StatTile label="D" value="4" href="/lab" /></>);
    expect(snap()).toMatchSnapshot();
  });
  it('DataTable: comfortable with row status, selection and bulk bar', () => {
    render(<DataTable {...base} density={'comfortable' as any} selection={sel(['r1', 'r2'])} {...loose({ rowStatus, bulkActions, onBulkAction: () => {} })} />);
    expect(snap()).toMatchSnapshot();
  });
  it('DataTable: compact, sticky, sorted, empty', () => {
    render(<DataTable {...base} rows={[]} density="compact" sort={{ value: 'name', onChange: () => {} }} />);
    expect(snap()).toMatchSnapshot();
  });
  it('Tabs: with counts', () => {
    render(<Tabs items={loose([{ id: 'a', label: 'To collect', count: 12 }, { id: 'b', label: 'Hold', count: 0 }, { id: 'c', label: 'Rejected' }])} selectedId="a" onChange={() => {}}>panel</Tabs>);
    expect(snap()).toMatchSnapshot();
  });
  it('Drawer: two sections', () => {
    mount2();
    expect(snap()).toMatchSnapshot();
  });
  it('PageShell: with help and banner', () => {
    render(<PageShell topBar={<span>top</span>} nav={<a href="#o">Orders</a>} help={<p>help</p>} banner={<p>banner</p>}>body</PageShell>);
    expect(snap()).toMatchSnapshot();
  });
  it('PermissionMatrix: privileged + read-only', () => {
    render(<PermissionMatrix label="Role" modules={[{ id: 'm1', label: 'Orders' }]} permissions={[{ code: 'order.read', moduleId: 'm1', resource: 'order' }, { code: 'order.void', moduleId: 'm1', resource: 'order', isPrivileged: true }, { code: 'order.pay', moduleId: 'm1', resource: 'order', isAssignable: false, unassignableReason: 'Platform only' }]} value={['order.read']} onChange={() => {}} />);
    expect(snap()).toMatchSnapshot();
  });
  it('StatusStepper: current and failed', () => {
    const steps = ['Uploaded', 'Scan', 'Commit'].map((label, i) => ({ id: `s${i}`, label }));
    render(<><StatusStepper steps={steps} currentId="s1" /><StatusStepper steps={steps} currentId="s1" outcome={{ kind: 'failed', label: 'Scan failed' }} /></>);
    expect(snap()).toMatchSnapshot();
  });
});

function mount2() {
  return render(
    <Drawer title="Centre" isOpen onClose={() => {}}>
      <DrawerSection title="Contact" onSave={() => {}}><p>phone</p></DrawerSection>
      <DrawerSection title="Billing" onSave={() => {}} isSaving><p>currency</p></DrawerSection>
    </Drawer>,
  );
}

describe('snapshots are recorded and committed (done_when: "visual snapshots of the kit recorded")', () => {
  it('__snapshots__/ui-r03-kit-pass.test.tsx.snap exists and holds an entry for each of the 9 kit components', () => {
    const f = join(COMPONENTS, '__tests__', '__snapshots__', 'ui-r03-kit-pass.test.tsx.snap');
    expect(existsSync(f), 'record with: pnpm --dir packages/ui exec vitest run -u src/components/__tests__/ui-r03-kit-pass.test.tsx').toBe(true);
    const text = readFileSync(f, 'utf8');
    for (const n of ['StatusChip', 'FlagBadge', 'StatTile', 'DataTable', 'Tabs', 'Drawer', 'PageShell', 'PermissionMatrix', 'StatusStepper']) {
      expect(text, n).toMatch(new RegExp(`exports\\[\`UI-R03 kit snapshots > ${n}:`));
    }
  });
});
