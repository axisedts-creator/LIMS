// HC-T18 — structure / copy / help / LD-140 of apps/web/src/app/(staff)/homecollection/dispatch and features/homecollection
// (04-UI-UX §1, §2.1, §2.6, §2.7, §6; 06-PLAN row HC-T18; 07-SECURITY §3 "Staff web H1–H21"; LD-140 UI rule). Static checks only (no rendering).
// Contract the tests import (spec fixes folders + kit components; dispute via the writer if wrong):
//   features/homecollection/components/{DispatchBoard,ScheduleDialog,AssignDialog,CancelVisitDialog}.tsx
//   features/homecollection/server/{actions,read.server,write.server}.ts      (same split as features/payments/server)
//   features/homecollection/nav.manifest.ts, help/dispatch.md, app/(staff)/homecollection/dispatch/{page,loading,error}.tsx
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const route = join(web, 'src/app/(staff)/homecollection/dispatch');
const feat = join(web, 'src/features/homecollection');
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (s: string) => [...strip(s).matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__tests__' ? [] : walk(join(d, n))) : [join(d, n)])) : []);
const code = (d: string) => walk(d).filter((f) => /\.(tsx?|mjs)$/.test(f));
const COMPONENTS = ['DispatchBoard', 'ScheduleDialog', 'AssignDialog', 'CancelVisitDialog'].map((n) => join(feat, 'components', `${n}.tsx`));
const SERVER = ['actions', 'read.server', 'write.server'].map((n) => join(feat, 'server', `${n}.ts`));
const files = () => [...code(route), ...code(feat)]; // everything HC-T18 owns (T19/T20 add files under the same tree; the rules are the same)

describe('files exist (names are the contract the tests import)', () => {
  it.each([...COMPONENTS, ...SERVER, join(feat, 'nav.manifest.ts'), join(feat, 'help', 'dispatch.md')])('%s', (f) => { expect(existsSync(f), f).toBe(true); });
});

describe('route files /homecollection/dispatch (04-UI-UX §2.6: loading.tsx → LoadingSkeleton, error.tsx → ErrorState with reference id, helpKey on PageHeader)', () => {
  it.each(['page.tsx', 'loading.tsx', 'error.tsx'])('%s exists', (f) => { expect(existsSync(join(route, f))).toBe(true); });
  it('error.tsx is a client component using ErrorState with onRetry and request id; page/loading are not client', () => {
    const e = read(join(route, 'error.tsx'));
    expect(strip(e).trimStart().startsWith("'use client'")).toBe(true);
    expect(e).toMatch(/ErrorState/);
    expect(e).toMatch(/onRetry=\{reset\}/);
    expect(e).toMatch(/digest|requestId|request_id/);
    expect(read(join(route, 'page.tsx'))).not.toMatch(/['"]use client['"]/);
  });
  it('loading.tsx uses LoadingSkeleton', () => { expect(read(join(route, 'loading.tsx'))).toMatch(/LoadingSkeleton/); });
  it('the PageHeader passes helpKey homecollection.dispatch', () => {
    const all = [...code(route), ...code(join(feat, 'components'))].map(read).join('\n');
    expect(all).toMatch(/helpKey=["'{]*homecollection\.dispatch/);
  });
  it('page checks homecollection.visit.read before any API call (notFound / PermissionDenied) and never reads a token itself', () => {
    const p = strip(read(join(route, 'page.tsx')));
    expect(p).toMatch(/notFound\(\)|PermissionDenied/);
    expect(p).toMatch(/getShellSession/);
    expect(p).toMatch(/homecollection\.visit\.read/);
    expect(p).not.toMatch(/getAccessToken|authorization|Bearer /i);
  });
});

describe('server boundary (07-SECURITY §3: BFF cookie only; tokens never reach the browser)', () => {
  it('actions.ts is a server-action file; read/write are server-only; components import no API client or serverFetch', () => {
    expect(strip(read(SERVER[0]!)).trimStart().startsWith("'use server'")).toBe(true);
    for (const f of SERVER) expect(read(f), f).toMatch(/import ['"]server-only['"]/);
    for (const f of COMPONENTS) expect(strip(read(f)), f).not.toMatch(/server-only|serverFetch|server\/(read|write)\.server|fetch\(/);
  });
  it('writes send Idempotency-Key (H3, H5, H6 required — TRD §5 preamble) and If-Match (versioned resources); the key comes from the caller, not Math.random', () => {
    const w = strip(read(SERVER[2]!));
    expect(w).toMatch(/[Ii]dempotency-Key/i);
    expect(w).toMatch(/If-Match/i);
    expect(w).not.toMatch(/Math\.random/);
  });
});

describe('imports and unsafe patterns (REQ-SEC-068; LD-140: packages/ui only, no hex colours, pixel radii or inline style objects)', () => {
  beforeEach(() => { expect(files().length, 'no HC-T18 code files yet — rules below would pass vacuously').toBeGreaterThanOrEqual(8); });
  it('only react / next / @lims/ui / @/core / @/features/homecollection / relative imports', () => {
    for (const f of files()) for (const i of importsOf(read(f))) expect(i, `${f}: ${i}`).toMatch(/^(react|react-dom|next\/[a-z-]+|server-only|@lims\/ui(\/.*)?|@lims\/shared-ts(\/.*)?|@\/core\/.*|@\/features\/homecollection\/.*|\.{1,2}\/.*)$/);
  });
  it('no raw HTML injection, browser storage, document.cookie, console logging, hand-built bearer header or hand-rolled table / select / dialog / textarea / input', () => {
    for (const f of files()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
      expect(s, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(s, f).not.toMatch(/authorization|Bearer /i);
      expect(s, f).not.toMatch(/<(table|select|dialog|textarea|input)[\s>]/);
    }
  });
  it('LD-140: no hex/rgb/hsl colours, no inline style objects, no pixel radii or border-radius, no raw rounded-* utilities', () => {
    for (const f of files()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(s, f).not.toMatch(/\bstyle=\{|\bstyle=["']/);
      expect(s, f).not.toMatch(/border-?[rR]adius|\brounded(-[a-z0-9]+)?\b|\d+px/);
    }
  });
  it('route reorder is button-based (04-UI-UX §2.7): no drag-and-drop attributes, events or libraries', () => {
    for (const f of files()) expect(strip(read(f)), f).not.toMatch(/draggable|onDrag|onDrop|dnd-kit|react-dnd|react-beautiful-dnd|useDrag|useDrop/i);
  });
  it('no phone, coordinates or note is logged, stored or put in a URL: the board never reads a phone field (H21 reveal is the visit page, HC-T19)', () => {
    for (const f of COMPONENTS.filter(existsSync)) expect(strip(read(f)), f).not.toMatch(/phone_e164|phoneE164|patient_phone|\.phone\b/);
  });
  it('uses the kit for what §2.1 names: PageHeader, FilterBar, DataTable, DatePicker, DateTimePicker, Select, Menu, Dialog/ConfirmDialog, StatusChip(generic), FlagBadge or Badge, Banner, Card, IconButton, DateText, DecimalField, IntegerField, TextArea, Form', () => {
    const all = files().map((f) => strip(read(f))).join('\n');
    for (const k of ['PageHeader', 'FilterBar', 'DataTable', 'DatePicker', 'DateTimePicker', 'Select', 'Menu', 'ConfirmDialog', 'StatusChip', 'Banner', 'Card', 'IconButton', 'DateText', 'DecimalField', 'IntegerField', 'TextArea', 'Form']) expect(all, k).toMatch(new RegExp(`\\b${k}\\b`));
    expect(all).toMatch(/\b(Badge|FlagBadge)\b/);
    expect(all).toMatch(/StatusChip[^>]*kind=["'{]+generic/);
    expect(all).toMatch(/size=["'{]+md/); // Schedule dialog is Dialog size=md
  });
  it('registers page shortcuts under "homecollection.dispatch" (Alt+D, Alt+A, Alt+S, Alt+R) via the shared registry; Ctrl+Enter is the kit default', () => {
    const b = strip(read(COMPONENTS[0]!));
    expect(b).toMatch(/shortcuts\.register\(\s*['"]homecollection\.dispatch['"]/);
    for (const k of ['Alt+D', 'Alt+A', 'Alt+S', 'Alt+R']) expect(b, k).toContain(k);
  });
  it('gates what the spec gates: Print labels on lab.specimen.label_print, dispatcher actions on homecollection.visit.assign; the label link targets /lab/orders/<order_id>/labels (routes.yaml staff.lab.order_labels)', () => {
    const b = strip(read(COMPONENTS[0]!));
    expect(b).toContain('lab.specimen.label_print');
    expect(b).toContain('homecollection.visit.assign');
    expect(b).toMatch(/\/lab\/orders\/.*\/labels/);
  });
  it('copy: coded sets are read from the API (H20) — no hard-coded cancel/unassign reason lists in code', () => {
    const all = files().map((f) => strip(read(f))).join('\n');
    expect(all).not.toMatch(/patient_cancelled|phlebotomist_unavailable|wrong_route/);
    expect(all).toMatch(/visit_cancel_reasons/);
    expect(all).toMatch(/unassign_reasons/);
  });
});

describe('help (04-UI-UX §6: features/homecollection/help/dispatch.md for helpKey homecollection.dispatch)', () => {
  const p = join(feat, 'help', 'dispatch.md');
  it('explains the board in plain words and warns against test names in the note', () => {
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(400);
    expect(t).toMatch(/^# /m);
    for (const n of [/unassigned/i, /schedule/i, /assign/i, /cancel/i, /print labels|labels/i, /order|sequence/i, /test names/i, /needs attention|flag/i, /keyboard|Alt\+/i]) expect(t).toMatch(n);
  });
  it('never leaks internals or promises what is not built (staff SMS is Phase 1 / not sent yet)', () => {
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t).not.toMatch(/stack trace|SELECT |INSERT |homecollection\.[a-z_]+\.v1|Bearer /i);
    expect(t).not.toMatch(/SMS (is|will be) sent|sends an SMS/i);
  });
});
