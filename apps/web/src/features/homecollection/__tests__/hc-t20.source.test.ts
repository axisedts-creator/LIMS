// HC-T20 — structure / copy / help / LD-140 of app/(staff)/homecollection/{handovers,devices,settings} and the HC-T20 files under features/homecollection
// (04-UI-UX §1, §2.3–2.7, §4, §5, §6; 06-PLAN row HC-T20; 07-SECURITY §3 + REQ-SEC-017/098; LD-140 UI rule). Static checks only (no rendering).
// Contract the tests import (spec fixes folders + kit components; dispute via the writer if wrong):
//   features/homecollection/components/{HandoversView,HandoverDrawer,DevicesView,SettingsForm}.tsx
//   features/homecollection/server/{actions,read.server,write.server}.ts  (extended: H13/H14/H16/H18/H20 reads, H15/H17/H19 writes)
//   features/homecollection/help/{handovers,devices,settings}.md, app/(staff)/homecollection/{handovers,devices,settings}/{page,loading,error}.tsx
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const app = join(web, 'src/app/(staff)/homecollection');
const feat = join(web, 'src/features/homecollection');
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (s: string) => [...strip(s).matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__tests__' ? [] : walk(join(d, n))) : [join(d, n)])) : []);
const code = (d: string) => walk(d).filter((f) => /\.(tsx?|mjs)$/.test(f));
const SCREENS = ['handovers', 'devices', 'settings'] as const;
const COMPONENTS = ['HandoversView', 'HandoverDrawer', 'DevicesView', 'SettingsForm'].map((n) => join(feat, 'components', `${n}.tsx`));
const comp = (n: string) => join(feat, 'components', `${n}.tsx`);
const routeFiles = () => SCREENS.flatMap((s) => code(join(app, s)));
const ownFiles = () => [...routeFiles(), ...COMPONENTS.filter(existsSync), ...['actions', 'read.server', 'write.server'].map((n) => join(feat, 'server', `${n}.ts`)).filter(existsSync)];
const PERM = { handovers: 'homecollection.handover.receive', devices: 'homecollection.device.manage', settings: 'homecollection.settings.manage' } as const;

describe('files exist (names are the contract the tests import)', () => {
  it.each([...COMPONENTS, ...SCREENS.flatMap((s) => ['page', 'loading', 'error'].map((f) => join(app, s, `${f}.tsx`))), ...SCREENS.map((s) => join(feat, 'help', `${s}.md`))])('%s', (f) => { expect(existsSync(f), f).toBe(true); });
});

describe('route files (04-UI-UX §2.6: loading.tsx → LoadingSkeleton, error.tsx → ErrorState with reference id, helpKey on PageHeader, permission before any API call)', () => {
  it.each(SCREENS)('%s: error.tsx is a client ErrorState with onRetry + request id; loading uses LoadingSkeleton; page is a server component', (s) => {
    const e = read(join(app, s, 'error.tsx'));
    expect(strip(e).trimStart().startsWith("'use client'")).toBe(true);
    expect(e).toMatch(/ErrorState/);
    expect(e).toMatch(/onRetry=\{reset\}/);
    expect(e).toMatch(/digest|requestId|request_id/);
    expect(read(join(app, s, 'loading.tsx'))).toMatch(/LoadingSkeleton/);
    expect(read(join(app, s, 'page.tsx'))).not.toMatch(/['"]use client['"]/);
  });
  it.each(SCREENS)('%s: page checks %s via getShellSession before any call, never reads a token itself', (s) => {
    const p = strip(read(join(app, s, 'page.tsx')));
    expect(p).toMatch(/notFound\(\)|PermissionDenied/);
    expect(p).toMatch(/getShellSession/);
    expect(p).toContain(PERM[s]);
    expect(p).not.toMatch(/getAccessToken|authorization|Bearer /i);
  });
  it.each(SCREENS)('%s: the PageHeader passes helpKey homecollection.%s', (s) => {
    const all = [...code(join(app, s)), ...COMPONENTS.filter(existsSync)].map((f) => read(f)).join('\n');
    expect(all).toMatch(new RegExp(`helpKey=["'{]*homecollection\\.${s}`));
  });
});

describe('server boundary (07-SECURITY §3: BFF cookie only; tokens never reach the browser)', () => {
  it('components import no API client, server module or fetch; the server files are server-only', () => {
    for (const f of COMPONENTS.filter(existsSync)) expect(strip(read(f)), f).not.toMatch(/server-only|serverFetch|server\/(read|write)\.server|fetch\(/);
    for (const n of ['read.server', 'write.server']) expect(read(join(feat, 'server', `${n}.ts`)), n).toMatch(/import ['"]server-only['"]/);
    expect(strip(read(join(feat, 'server', 'actions.ts'))).trimStart().startsWith("'use server'")).toBe(true);
  });
  it('reads use the H-paths: /handovers, /devices, /settings, set=wipe_reasons; writes: confirm, wipe, PUT settings', () => {
    const r = strip(read(join(feat, 'server', 'read.server.ts')));
    for (const k of ['/handovers', '/devices', '/settings', 'wipe_reasons']) expect(r, k).toContain(k);
    const w = strip(read(join(feat, 'server', 'write.server.ts')));
    expect(w).toMatch(/\/confirm/);
    expect(w).toMatch(/\/wipe/);
    expect(w).toMatch(/PUT/);
  });
  it('H15 and H17 send Idempotency-Key (TRD §5 preamble) and If-Match; H19 sends If-Match; the key is supplied by the caller (retry = same key), not Math.random', () => {
    const w = strip(read(join(feat, 'server', 'write.server.ts')));
    expect(w).toMatch(/[Ii]dempotency-Key/);
    expect(w).toMatch(/If-Match/i);
    expect(w).not.toMatch(/Math\.random/);
  });
});

describe('imports and unsafe patterns (REQ-SEC-068; LD-140: packages/ui only, no hex colours, pixel radii or inline style objects)', () => {
  it('only react / next / @lims/ui / @/core / @/features/homecollection / relative imports', () => {
    expect(ownFiles().length, 'no HC-T20 files yet — the rules below would pass vacuously').toBeGreaterThanOrEqual(12);
    for (const f of ownFiles()) for (const i of importsOf(read(f))) expect(i, `${f}: ${i}`).toMatch(/^(react|react-dom|next\/[a-z-]+|server-only|@lims\/ui(\/.*)?|@lims\/shared-ts(\/.*)?|@\/core\/.*|@\/features\/homecollection\/.*|\.{1,2}\/.*)$/);
  });
  it('no raw HTML injection, browser storage, console logging, hand-built bearer header or hand-rolled table / select / dialog / textarea / input', () => {
    expect(ownFiles().length).toBeGreaterThanOrEqual(12);
    for (const f of ownFiles()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
      expect(s, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(s, f).not.toMatch(/authorization|Bearer /i);
      expect(s, f).not.toMatch(/<(table|select|dialog|textarea|input)[\s>]/);
    }
  });
  it('LD-140: no hex/rgb/hsl colours, no inline style objects, no pixel radii or border-radius, no raw rounded-* utilities', () => {
    expect(ownFiles().length).toBeGreaterThanOrEqual(12);
    for (const f of ownFiles()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(s, f).not.toMatch(/\bstyle=\{|\bstyle=["']/);
      expect(s, f).not.toMatch(/border-?[rR]adius|\brounded(-[a-z0-9]+)?\b|\d+px/);
    }
  });
  it('scan input is the kit BarcodeInput (label "Scan tube", never a hand-rolled <input>), with useScanCapture while the drawer is open; the value is never logged or stored', () => {
    const d = strip(read(comp('HandoverDrawer')));
    expect(d).toMatch(/\bBarcodeInput\b/);
    expect(d).toContain('Scan tube');
    expect(d).toMatch(/\buseScanCapture\b/);
    expect(d).toMatch(/\bDrawer\b/);
    expect(d).toMatch(/width=["'{]+lg/);
    expect(d).not.toMatch(/localStorage|sessionStorage|console\./);
  });
  it('the handover drawer never links to or reads visits (D-125): no /homecollection/visits, no visit_id use in rendered output', () => {
    const d = strip(read(comp('HandoverDrawer'))) + strip(read(comp('HandoversView')));
    expect(d).not.toMatch(/\/homecollection\/visits|\/visits\//);
    expect(d).not.toMatch(/visit_id|visitId/);
  });
  it('uses the kit for what §2.3–2.5 names: PageHeader, DataTable, StatusChip(generic), Drawer, ConfirmDialog (danger + requireReason), Checkbox, Switch, IntegerField, TextField, TextArea(showCount), RadioGroup, Select, Form, Banner', () => {
    const all = ownFiles().map((f) => strip(read(f))).join('\n');
    for (const k of ['PageHeader', 'DataTable', 'StatusChip', 'Drawer', 'ConfirmDialog', 'Checkbox', 'Switch', 'IntegerField', 'TextField', 'TextArea', 'RadioGroup', 'Select', 'Form', 'Banner', 'Button']) expect(all, k).toMatch(new RegExp(`\\b${k}\\b`));
    expect(all).toMatch(/StatusChip[^>]*kind=["'{]+generic/);
    expect(strip(read(comp('DevicesView')))).toMatch(/tone=["'{]+danger/);
    expect(strip(read(comp('DevicesView')))).toMatch(/requireReason/);
    expect(strip(read(comp('SettingsForm')))).toMatch(/showCount/);
  });
  it('wipe reasons come from the API (H20 set wipe_reasons) — no hard-coded reason list in code', () => {
    const all = ownFiles().map((f) => strip(read(f))).join('\n');
    expect(all).not.toMatch(/\b(stolen|reassigned)\b/);
    expect(all).toMatch(/wipe_reasons/);
  });
  it('payment codes: only the C4 seed set appears, and only in SettingsForm (D-128)', () => {
    const s = strip(read(comp('SettingsForm')));
    for (const c of ['cash', 'card', 'esewa', 'khalti', 'fonepay_qr', 'bank_transfer']) expect(s, c).toContain(c);
    expect(s).not.toMatch(/['"](paypal|stripe|bitcoin|upi)['"]/i);
  });
  it('no phone, coordinates or note is rendered by these screens', () => {
    for (const f of COMPONENTS.filter(existsSync)) expect(strip(read(f)), f).not.toMatch(/phone_e164|phoneE164|patient_phone|\.phone\b/);
  });
});

describe('nav (04-UI-UX §1): the three entries already exist and are not changed by HC-T20', () => {
  it('handovers `g t`, devices and settings keep their permission, routeId and group', async () => {
    const { navManifest } = await import('../nav.manifest.ts');
    const by = Object.fromEntries(navManifest.entries.map((e) => [e.id, e]));
    expect(by['homecollection.handovers']).toMatchObject({ routeId: 'staff.homecollection.handovers', permission: PERM.handovers, chord: 'g t', group: 'home_collection' });
    expect(by['homecollection.devices']).toMatchObject({ routeId: 'staff.homecollection.devices', permission: PERM.devices });
    expect(by['homecollection.settings']).toMatchObject({ routeId: 'staff.homecollection.settings', permission: PERM.settings });
  });
});

describe('help (04-UI-UX §6: features/homecollection/help/{handovers,devices,settings}.md)', () => {
  const need: Record<(typeof SCREENS)[number], RegExp[]> = {
    handovers: [/scan/i, /confirm/i, /missing/i, /waiting|pending/i, /dispatcher/i, /Ctrl\+Enter/i],
    devices: [/wipe/i, /next (connection|time)|connects/i, /sign.?off|signed off/i, /update required|app version/i, /revoke|sessions/i, /lost|stolen/i],
    settings: [/sync/i, /gps/i, /maps/i, /payment/i, /handover/i, /consent/i, /pending|not (built|available|sent)/i, /Ctrl\+Enter/i],
  };
  it.each(SCREENS)('%s.md explains the screen in plain words', (s) => {
    const p = join(feat, 'help', `${s}.md`);
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(300);
    expect(t).toMatch(/^# /m);
    for (const n of need[s]) expect(t, String(n)).toMatch(n);
  });
  it.each(SCREENS)('%s.md leaks no internals and promises nothing that is not built (staff SMS is Phase 1; GPS / patient SMS pending)', (s) => {
    const p = join(feat, 'help', `${s}.md`);
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t).not.toMatch(/stack trace|SELECT |INSERT |homecollection\.[a-z_]+\.v1|Bearer |auth\.[a-z_]+/i);
    expect(t).not.toMatch(/SMS (is|will be) sent|sends an SMS|GPS (is|will be) captured/i);
  });
});
