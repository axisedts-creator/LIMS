// @vitest-environment jsdom
// T0D-DENSITY-1 (LD-310, founder 2026-11-17 04:49 and 05:03 NPT; measured by the lead 05:20 NPT): compact density for the staff app.
//   Compact = an element with data-density="compact" that is an ancestor of the controls (the shell root or a wrapper).
//   Compact: text field, select, combobox, date picker, button 30; icon button 30 x 30; table row 28; body/table text 13; helper/caption >= 12;
//   vertical gaps ~35 percent below today (16 -> about 10); every interactive control >= 24 (WCAG 2.2 AA 2.5.8); focus ring not clipped;
//   at 1366 x 768 a list screen shows >= 20 rows below the page header. Regular (data-density="regular" or no attribute) is unchanged.
//   REPLACES the written kit rule "dense fields stay at 40" (spec 13 s2.3); m-series-kit.test.tsx is rewritten to 30 for the same reason.
//
// How it is measured: the real components are rendered in jsdom, the real kit.css + dist/tokens.css (+ apps/web shell.css for the layout test) are parsed,
// and a small cascade (specificity, then source order, var() through custom properties set on the element or an ancestor) is evaluated for each element.
// jsdom has no layout, so heights are the CSS values (min-height / height, and content + padding for table rows). Nothing is mocked.
// dist/tokens.css is generated: run `pnpm --dir packages/ui run build` first (the verify.cmd does).
//
// CONTRACT chosen here where the brief gives no name (writer: follow it, or file a dispute):
//   <Form labelPlacement="start" | "above">  default "above". "start" renders data-label-placement="start" on the <form class="lims-form">,
//   and inside compact the kit puts each .lims-field in a row (flex-direction: row) so the label sits at the start side of the field.
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Button } from '../Button/Button';
import { Checkbox } from '../Checkbox/Checkbox';
import { Combobox } from '../Combobox/Combobox';
import { DataTable } from '../DataTable/DataTable';
import { DatePicker } from '../DatePicker/DatePicker';
import { Form } from '../Form/Form';
import { IconButton } from '../IconButton/IconButton';
import { PageHeader } from '../PageHeader/PageHeader';
import { Select } from '../Select/Select';
import { Tabs } from '../Tabs/Tabs';
import { TextField } from '../TextField/TextField';

const UI = process.cwd(); // vitest root = packages/ui
const ROOT = resolve(UI, '..', '..');
const tokens = JSON.parse(readFileSync(join(UI, 'tokens', 'tokens.json'), 'utf8'));

// ---------------------------------------------------------------- css reader with a small cascade
type Rule = { sels: string[]; decls: Map<string, string>; media: string; order: number };
const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
function parseCss(src: string): Rule[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const media: string[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    const close = s.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) { media.pop(); i = close + 1; continue; }
    const prelude = s.slice(i, open).trim();
    if (/^@(media|supports|layer)/.test(prelude)) { media.push(prelude); i = open + 1; continue; }
    let end = s.indexOf('}', open);
    if (prelude.startsWith('@')) { // @keyframes and other nested blocks: skip the whole block
      let depth = 1; let j = open + 1;
      while (j < s.length && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
      i = j; continue;
    }
    const decls = new Map<string, string>();
    for (const d of s.slice(open + 1, end).split(';')) {
      const k = d.indexOf(':');
      if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim().replace(/\s+/g, ' '));
    }
    out.push({ sels: splitTop(prelude).map((x) => x.replace(/\s+/g, ' ').replace(/"/g, "'")), decls, media: media.join(' '), order: out.length });
    i = end + 1;
  }
  return out;
}
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
const KIT_CSS = read(UI, 'src', 'components', 'kit.css');
const TOKENS_CSS = read(UI, 'dist', 'tokens.css');
const SHELL_CSS = read(ROOT, 'apps', 'web', 'src', 'core', 'shell', 'shell.css');
const withOrder = (rs: Rule[], offset: number) => rs.map((r) => ({ ...r, order: r.order + offset }));
const tokenRules = parseCss(TOKENS_CSS);
const kitRules = withOrder(parseCss(KIT_CSS), 10_000);
const shellRules = withOrder(parseCss(SHELL_CSS), 20_000);
const kitOnly = [...tokenRules, ...kitRules];
const kitAndShell = [...tokenRules, ...kitRules, ...shellRules];

const specificity = (sel: string): number => {
  const s = sel.replace(/:where\([^)]*\)/g, '');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (s.replace(/\[[^\]]*\]|[.#:][\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + cls * 100 + tags;
};
/** effective declared value of `prop` on `el` (base rules, no media); later wins on equal specificity. */
function declOn(el: Element, prop: string, rules: Rule[]): string | undefined {
  let best: { spec: number; order: number; v: string } | undefined;
  for (const r of rules) {
    if (r.media || !r.decls.has(prop)) continue;
    for (const sel of r.sels) {
      let hit = false;
      try { hit = el.matches(sel.replace(/:where\([^)]*\)/g, '')); } catch { hit = false; }
      if (!hit) continue;
      const spec = specificity(sel);
      if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, v: r.decls.get(prop)! };
    }
  }
  return best?.v;
}
/** custom property: the element's own value or the nearest ancestor's (inherited). */
function customProp(el: Element, name: string, rules: Rule[]): string | undefined {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const v = declOn(cur, name, rules);
    if (v !== undefined) return v;
  }
  return undefined;
}
function resolveVars(el: Element, v: string | undefined, rules: Rule[], depth = 0): string | undefined {
  if (v === undefined || depth > 6) return v;
  return v.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (_m, name: string, fb?: string) => resolveVars(el, customProp(el, name, rules) ?? fb, rules, depth + 1) ?? 'NaN');
}
const toPx = (v: string | undefined): number => {
  const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec((v ?? '').trim());
  if (!m) return NaN;
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
};
const px = (el: Element, prop: string, rules: Rule[] = kitOnly) => toPx(resolveVars(el, declOn(el, prop, rules), rules));
/** values of a 1-4 value box shorthand (padding, margin) as [top, right, bottom, left] px */
function box(el: Element, prop: 'padding' | 'margin', rules: Rule[]): [number, number, number, number] {
  const sh = resolveVars(el, declOn(el, prop, rules), rules)?.split(' ').map(toPx) ?? [0];
  const [a = 0, b = a, c = a, d = b] = sh;
  const out: [number, number, number, number] = [a, b, c, d];
  const pb = declOn(el, `${prop}-block`, rules);
  if (pb !== undefined) { const [s = 0, e = s] = resolveVars(el, pb, rules)!.split(' ').map(toPx); out[0] = s; out[2] = e; }
  for (const [side, i] of [['top', 0], ['bottom', 2]] as const) {
    const v = declOn(el, `${prop}-${side}`, rules);
    if (v !== undefined) out[i] = toPx(resolveVars(el, v, rules));
  }
  return out;
}
/** inherited font-size / line-height in px (climbs to the ancestor that sets it) */
function inherited(el: Element, prop: 'font-size' | 'line-height', rules: Rule[] = kitOnly): number {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const v = declOn(cur, prop, rules);
    if (v !== undefined) return toPx(resolveVars(cur, v, rules));
  }
  return NaN;
}

// ---------------------------------------------------------------- render helpers
const compactHost = (density: 'compact' | 'regular' | null = 'compact') => {
  const host = document.createElement('div');
  host.className = 'lims-root lims-shell';
  if (density) host.setAttribute('data-density', density);
  document.body.append(host);
  return host;
};
const mountIn = (host: HTMLElement, ui: React.ReactElement) => render(ui, { container: host.appendChild(document.createElement('div')) }).container;
const q = (c: ParentNode, sel: string): Element => {
  const el = c.querySelector(sel);
  expect(el, `${sel} not rendered`).toBeTruthy();
  return el!;
};
const noop = () => {};
const opt = [{ value: 'f', label: 'Female' }];

type Row = { id: string; name: string; state: string };
const tableProps = {
  caption: 'Patients',
  columns: [{ id: 'name', header: 'Name', cell: (r: Row) => r.name, isRowHeader: true }, { id: 'state', header: 'State', cell: (r: Row) => r.state }],
  rows: [{ id: 'r1', name: 'Alpha', state: 'ok' }, { id: 'r2', name: 'Bravo', state: 'ok' }] as Row[],
  getRowId: (r: Row) => r.id,
  emptyState: { title: 'None' },
};
/** the CSS height of a table row: the larger of its height / min-height and its content (line + vertical padding) */
function rowHeight(tr: Element, rules: Rule[] = kitOnly): number {
  const declared = Math.max(...['height', 'min-height'].map((p) => px(tr, p, rules)).filter((n) => !Number.isNaN(n)), 0);
  const cell = q(tr, 'td, th');
  const [pt, , pb] = box(cell, 'padding', rules);
  const lh = inherited(cell, 'line-height', rules);
  return Math.max(declared, (Number.isNaN(lh) ? 0 : lh) + pt + pb);
}
const controlHeight = (el: Element, rules: Rule[] = kitOnly) => Math.max(px(el, 'min-height', rules), px(el, 'height', rules) || 0);

// ---------------------------------------------------------------- 1. the sizes in compact (done_when 2)
describe('compact density: control heights (founder 2026-11-17, LD-310)', () => {
  it('TextField input, Select trigger, Combobox input and DatePicker input are 30 px high', () => {
    const host = compactHost();
    const c = mountIn(host, (
      <div>
        <TextField label="Name" name="n" maxLength={20} />
        <Select label="Sex" name="s" options={opt} />
        <Combobox label="City" name="c" loadOptions={async () => []} getKey={(x: string) => x} renderOption={(x: string) => x} renderValue={(x: string) => x} />
        <DatePicker label="Born" name="b" />
      </div>
    ));
    const all = [...c.querySelectorAll('.lims-input')];
    expect(all.length, 'four .lims-input controls rendered').toBe(4);
    ['TextField', 'Select', 'Combobox', 'DatePicker'].forEach((name, i) => expect(px(all[i]!, 'min-height'), `${name} min-height`).toBe(30));
    expect(all[1]!.classList.contains('lims-select-trigger')).toBe(true);
    expect(all[3]!.closest('.lims-date-field')).toBeTruthy();
  });
  it('Button (md) is 30 px high and uses min-height, never height', () => {
    const c = mountIn(compactHost(), <Button>Save</Button>);
    const b = q(c, '.lims-btn');
    expect(px(b, 'min-height')).toBe(30);
    expect(declOn(b, 'height', kitOnly)).toBeUndefined();
  });
  it('Button sm never grows past 30 and stays a real target (>= 24)', () => {
    const b = q(mountIn(compactHost(), <Button size="sm">Go</Button>), '.lims-btn');
    expect(px(b, 'min-height')).toBeLessThanOrEqual(30);
    expect(px(b, 'min-height')).toBeGreaterThanOrEqual(24);
  });
  it('IconButton keeps a 30 x 30 px square click target', () => {
    const b = q(mountIn(compactHost(), <IconButton label="Close" icon="close" onPress={noop} />), '.lims-icon-btn');
    expect(px(b, 'min-height'), 'min-height').toBe(30);
    expect(px(b, 'min-width'), 'min-width').toBe(30);
  });
  it('a table row is 28 px in a compact app, for the default and the compact DataTable density', () => {
    for (const density of [undefined, 'compact', 'regular'] as const) {
      const c = mountIn(compactHost(), <DataTable {...tableProps} {...(density ? { density } : {})} />);
      const tr = q(c, 'tbody tr, [role="row"]:not(:first-child)');
      expect(rowHeight(tr), `row height, density ${density ?? 'default'}`).toBe(28);
    }
  });
  it('header cells of the table are 28 px too (an empty table shows its header)', () => {
    const c = mountIn(compactHost(), <DataTable {...tableProps} />);
    expect(rowHeight(q(c, 'thead tr')), 'thead row').toBeLessThanOrEqual(28);
  });
});

// ---------------------------------------------------------------- 2. regular is unchanged and still available (done_when 1)
describe('regular density stays available and unchanged', () => {
  it.each([['regular'], [null]] as const)('data-density=%s: field 46, button 48, table row 40 (the M series sizes)', (density) => {
    const host = compactHost(density);
    const c = mountIn(host, (
      <div>
        <TextField label="Name" name="n" maxLength={20} />
        <Select label="Sex" name="s" options={opt} />
        <Button>Save</Button>
        <DataTable {...tableProps} />
      </div>
    ));
    expect(px(q(c, 'input'), 'min-height')).toBe(46);
    expect(px(q(c, '.lims-select-trigger'), 'min-height')).toBe(46);
    expect(px(q(c, '.lims-btn'), 'min-height')).toBe(48);
    expect(rowHeight(q(c, 'tbody tr'))).toBe(40);
    expect(inherited(q(c, 'input'), 'font-size')).toBe(14);
  });
});

// ---------------------------------------------------------------- 3. text sizes (done_when 2)
describe('compact density: text', () => {
  it('body, label, input, button and table text are 13 px', () => {
    const c = mountIn(compactHost(), (
      <div>
        <TextField label="Name" name="n" maxLength={20} />
        <Button>Save</Button>
        <DataTable {...tableProps} />
      </div>
    ));
    for (const [what, el] of [['label', q(c, '.lims-label')], ['input', q(c, 'input')], ['button', q(c, '.lims-btn')], ['td', q(c, 'tbody td')], ['th', q(c, 'thead th')]] as const)
      expect(inherited(el, 'font-size'), `${what} font-size`).toBe(13);
  });
  it('helper, error and counter text stay between 12 and 13 px (never below 12)', () => {
    const host = compactHost();
    const c = mountIn(host, <TextField label="Name" name="n" maxLength={20} description="Legal name" />);
    for (const sel of ['.lims-description', '.lims-count']) {
      const el = c.querySelector(sel);
      if (!el) continue;
      expect(inherited(el, 'font-size'), sel).toBeGreaterThanOrEqual(12);
      expect(inherited(el, 'font-size'), sel).toBeLessThanOrEqual(13);
    }
    for (const sel of ['.lims-error', '.lims-chip-sm', '.lims-kbd', '.lims-tab-badge']) {
      const el = document.createElement('span');
      el.className = sel.slice(1);
      host.append(el);
      expect(inherited(el, 'font-size'), sel).toBeGreaterThanOrEqual(12);
    }
  });
  it('no rule in kit.css or shell.css sets a font-size under 12 px (compact or not)', () => {
    const small: string[] = [];
    for (const r of [...kitRules, ...shellRules]) {
      const v = r.decls.get('font-size');
      if (!v) continue;
      const el = document.createElement('div');
      const n = toPx(resolveVars(el, v, tokenRules));
      if (!Number.isNaN(n) && n < 12) small.push(`${r.sels.join(',')}: ${v}`);
    }
    expect(small).toEqual([]);
    const font = [...kitRules, ...shellRules].flatMap((r) => (r.decls.has('font') && /(^|\s)(\d+(\.\d+)?)px/.test(r.decls.get('font')!) ? [r.sels.join(',')] : []));
    expect(font, 'shorthand font: with a px size').toEqual([]);
  });
});

// ---------------------------------------------------------------- 4. gaps (done_when 2: about 35 percent below today)
describe('compact density: vertical gaps about 35 percent below today (16 -> about 10)', () => {
  it('the gap between form fields is 9 to 12 px (regular is 16)', () => {
    const regular = q(mountIn(compactHost('regular'), <Form onSubmit={noop}><TextField label="A" name="a" maxLength={9} /></Form>), 'form.lims-form');
    expect(px(regular, 'gap')).toBe(16);
    const compact = q(mountIn(compactHost(), <Form onSubmit={noop}><TextField label="A" name="a" maxLength={9} /></Form>), 'form.lims-form');
    const gap = px(compact, 'gap');
    expect(gap, `form gap ${gap}`).toBeGreaterThanOrEqual(9);
    expect(gap).toBeLessThanOrEqual(12);
  });
  it('the gap inside one field (label to input) is at most 4 px and at least 2', () => {
    const f = q(mountIn(compactHost(), <TextField label="A" name="a" maxLength={9} />), '.lims-field');
    expect(px(f, 'gap')).toBeLessThanOrEqual(4);
    expect(px(f, 'gap')).toBeGreaterThanOrEqual(2);
  });
  it('card padding and the page header gap shrink as well (space tokens, not only fields)', () => {
    const host = compactHost();
    const card = document.createElement('div'); card.className = 'lims-card'; host.append(card);
    const hdr = document.createElement('div'); hdr.className = 'lims-page-header'; host.append(hdr);
    expect(box(card, 'padding', kitOnly)[0], 'card padding').toBeLessThanOrEqual(16);
    expect(px(hdr, 'margin-bottom')).toBeLessThanOrEqual(12);
  });
});

// ---------------------------------------------------------------- 5. labels on the left (done_when 2, a prop on the form layout)
describe('Form labelPlacement', () => {
  const formWith = (extra: object) =>
    mountIn(compactHost(), <Form onSubmit={noop} {...extra}><TextField label="Family name" name="fam" maxLength={30} /></Form>);
  it('default keeps the label above the field: no start marker, fields stay in a column', () => {
    const c = formWith({});
    const form = q(c, 'form.lims-form');
    expect(form.getAttribute('data-label-placement') ?? 'above').not.toBe('start');
    expect(declOn(q(c, '.lims-field'), 'flex-direction', kitOnly) ?? 'column').toBe('column');
  });
  it('labelPlacement="above" is the same as the default', () => {
    const form = q(formWith({ labelPlacement: 'above' }), 'form.lims-form');
    expect(form.getAttribute('data-label-placement') ?? 'above').toBe('above');
  });
  it('labelPlacement="start" marks the form and lays the field out as a row, label first', () => {
    const c = formWith({ labelPlacement: 'start' });
    expect(q(c, 'form.lims-form').getAttribute('data-label-placement')).toBe('start');
    const field = q(c, '.lims-field');
    expect(declOn(field, 'flex-direction', kitOnly)).toBe('row');
    expect(field.firstElementChild?.tagName).toBe('LABEL');
  });
  it('the label is still associated with its input (accessible name unchanged)', () => {
    const c = formWith({ labelPlacement: 'start' });
    const input = q(c, 'input') as HTMLInputElement;
    expect(input.labels?.[0]?.textContent).toContain('Family name');
  });
});

// ---------------------------------------------------------------- 6. WCAG 2.2 AA target size (done_when 4)
describe('compact density: no interactive control is below 24 px (WCAG 2.2 AA 2.5.8)', () => {
  it('every interactive kit control resolves to a height of at least 24 in compact', () => {
    const c = mountIn(compactHost(), (
      <div>
        <TextField label="Name" name="n" maxLength={20} />
        <Select label="Sex" name="s" options={opt} />
        <DatePicker label="Born" name="b" />
        <Button>Save</Button>
        <Button size="sm">Sm</Button>
        <IconButton label="Close" icon="close" onPress={noop} />
        <Checkbox label="Agree" name="agree" />
        <Tabs items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} selectedId="a" onChange={noop} />
        <DataTable {...tableProps} />
      </div>
    ));
    const bad: string[] = [];
    const interactive = c.querySelectorAll('input:not([type="hidden"]), button, [role="button"], [role="tab"], .lims-check, .lims-radio, .lims-switch, .lims-select-trigger, tbody tr');
    expect(interactive.length).toBeGreaterThan(8);
    for (const el of interactive) {
      if (el.closest('[aria-hidden="true"], [hidden]')) continue; // react-aria hidden mirrors of a select
      if (el.tagName === 'TR') { if (rowHeight(el) < 24) bad.push(`tr: ${rowHeight(el)}`); continue; }
      if (el.matches('input[type="checkbox"], input[type="radio"]')) continue; // the 16 px box sits inside its 24 px .lims-check target
      const h = controlHeight(el);
      if (!(h >= 24)) bad.push(`${el.tagName}.${el.className}: ${h}`);
    }
    expect(bad).toEqual([]);
  });
  it('the checkbox, radio and switch targets are at least 24 px', () => {
    const host = compactHost();
    for (const cls of ['lims-check', 'lims-radio', 'lims-switch']) {
      const el = document.createElement('label'); el.className = cls; host.append(el);
      expect(controlHeight(el), cls).toBeGreaterThanOrEqual(24);
    }
  });
  it('no compact-scoped rule sets a control height or width under 24 px', () => {
    const rules = [...kitRules, ...shellRules].filter((r) => r.sels.some((s) => /data-density/.test(s)));
    expect(rules.length, 'compact rules exist').toBeGreaterThan(3);
    const bad: string[] = [];
    for (const r of rules) for (const p of ['min-height', 'height', 'min-width', 'width']) {
      const n = toPx(resolveVars(document.createElement('div'), r.decls.get(p), tokenRules));
      if (!Number.isNaN(n) && n > 0 && n < 24) bad.push(`${r.sels.join(',')} ${p}: ${r.decls.get(p)}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- 7. focus rings (done_when 5)
describe('compact density: focus rings stay visible and are not clipped', () => {
  it('the focus-visible outline is 2 px solid focus.ring with a non-negative offset, and no compact rule removes it', () => {
    const rule = kitRules.find((r) => r.sels.some((s) => /:focus-visible/.test(s) && /lims-input/.test(s)) && r.decls.has('outline'));
    expect(rule, 'kit focus-visible rule').toBeTruthy();
    expect(rule!.decls.get('outline')).toBe('2px solid var(--lims-focus-ring)');
    expect(toPx(rule!.decls.get('outline-offset'))).toBeGreaterThanOrEqual(0);
    const removers = [...kitRules, ...shellRules].filter((r) => r.sels.some((s) => /data-density/.test(s) && /focus/.test(s)) && /^(0|none)\b|transparent/.test(r.decls.get('outline') ?? ''));
    expect(removers.map((r) => r.sels.join(','))).toEqual([]);
  });
  it('containers that hold fields do not clip overflow (a ring sticks out 4 px)', () => {
    const c = mountIn(compactHost(), (
      <Form onSubmit={noop}>
        <TextField label="A" name="a" maxLength={9} />
      </Form>
    ));
    const host = c.closest('.lims-shell')!;
    const els: Element[] = [q(c, 'form.lims-form'), q(c, '.lims-field'), ...['lims-input-group', 'lims-filter-bar', 'lims-shell-main'].map((cls) => { const e = document.createElement('div'); e.className = cls; host.append(e); return e; })];
    for (const el of els) for (const p of ['overflow', 'overflow-x', 'overflow-y']) expect(declOn(el, p, kitAndShell) ?? 'visible', `${el.className} ${p}`).toBe('visible');
  });
  it('stacked fields keep at least 6 px between them so one ring never covers the next field', () => {
    const form = q(mountIn(compactHost(), <Form onSubmit={noop}><TextField label="A" name="a" maxLength={9} /></Form>), 'form.lims-form');
    expect(px(form, 'gap')).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------- 8. one screen: 20 rows at 1366 x 768 (done_when 7)
describe('compact density: a list screen shows at least 20 rows below the page header at 1366 x 768', () => {
  it('chrome (top bar + page padding + page header + table header) leaves room for 20 rows of 28 px', () => {
    const VIEWPORT_H = 768;
    const host = compactHost();
    host.className = 'lims-shell'; // real shell classes from shell.css apply
    const top = document.createElement('header'); top.className = 'lims-shell-top';
    const bar = document.createElement('div'); bar.className = 'lims-topbar'; top.append(bar);
    const bell = document.createElement('button'); bell.className = 'lims-btn lims-topbar-bell';
    const search = document.createElement('input'); search.className = 'lims-input lims-search-input';
    const switcher = document.createElement('select'); switcher.className = 'lims-input lims-centre-switcher';
    bar.append(bell, search, switcher);
    const body = document.createElement('div'); body.className = 'lims-shell-body';
    const main = document.createElement('main'); main.className = 'lims-shell-main';
    body.append(main); host.append(top, body);
    const page = mountIn(main, (
      <div>
        <PageHeader title="Patients" helpKey="patients" actions={<Button variant="primary">New patient</Button>} />
        <DataTable {...tableProps} />
      </div>
    ));

    const rules = kitAndShell;
    const barH = Math.max(px(top, 'min-height', rules), ...[bell, search, switcher].map((e) => controlHeight(e, rules)));
    const [topPadT, , topPadB] = box(top, 'padding', rules);
    const topbar = barH + topPadT + topPadB + (/^\d/.test(declOn(top, 'border-bottom', rules) ?? '') ? 1 : 0);
    const [padT, , padB] = box(main, 'padding', rules);
    const header = q(page, '.lims-page-header');
    const headerRow = q(header, '.lims-page-header-row');
    const rowKids = [...headerRow.children].map((k) => (k.matches('h1') ? inherited(k, 'line-height', rules) : Math.max(...[...k.querySelectorAll('.lims-btn')].map((b) => controlHeight(b, rules)), 0)));
    const headerH = Math.max(...rowKids) + (px(header, 'margin-bottom', rules) || 0) + (box(header, 'padding', rules)[0] + box(header, 'padding', rules)[2]);
    const trH = rowHeight(q(page, 'tbody tr'), rules);
    const theadH = rowHeight(q(page, 'thead tr'), rules);

    const room = VIEWPORT_H - topbar - padT - padB - headerH - theadH;
    const rows = Math.floor(room / trH);
    console.info(`DENSITY-ROWS at 1366x768: ${rows} rows (top bar ${topbar}, page padding ${padT}+${padB}, page header ${headerH}, table header ${theadH}, row ${trH})`);
    expect(trH).toBe(28);
    expect(rows).toBeGreaterThanOrEqual(20);
  });
});
