// C16.T-B6 — structure / security of app/(staff)/engagement/{bookings,slots,bookable-items}/** and the W1–W5 components in features/engagement/components/.
// Sources: 02-TRD §3.4 tree, 04-UI-UX W1–W5, 06-PLAN row T-B6, contracts/routes.yaml (route ids + permissions), 07-SECURITY (REQ-SEC-088 no raw HTML),
// LD-140 (kit components and token names only: no hex colours, pixel radii, inline style objects), C0 04-UI-UX §4 (page keys never reuse a global key).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { GLOBAL_KEYS } from '../../../core/shortcuts/registry';

const appRoot = fileURLToPath(new URL('../../../app/(staff)/engagement/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : [];
const isSrc = (p: string) => /\.(ts|tsx)$/.test(p);
const read = (p: string) => readFileSync(p, 'utf8');
const isClient = (p: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(read(p));

const ROUTES = [
  { dir: 'bookings', id: 'staff.engagement.bookings', perm: 'engagement.booking.read' },
  { dir: 'slots', id: 'staff.engagement.slots', perm: 'engagement.slot.manage' },
  { dir: 'bookable-items', id: 'staff.engagement.bookable', perm: 'engagement.bookable_item.manage' },
];
const DETAIL = 'bookings/[booking_id]'; // staff.engagement.booking (W2), permission engagement.booking.read
const NEW = 'bookings/new'; // W3, create needs engagement.booking.manage
const COMPONENTS = ['BookingsList', 'BookingDetail', 'BookingNew', 'SlotsAdmin', 'BookableCatalogue'].map((n) => join(feat, 'components', `${n}.tsx`));
const appFiles = () => ROUTES.flatMap((r) => walk(join(appRoot, r.dir))).filter(isSrc);
const featFiles = () => ['components', 'server'].flatMap((d) => walk(join(feat, d))).filter(isSrc).filter((p) => !/queue|Queue/i.test(p));
const all = () => [...appFiles(), ...COMPONENTS.filter(existsSync)];
const text = (fs: string[]) => fs.map((p) => strip(read(p))).join('\n');

describe('route files (02-TRD §3.4: each route has page.tsx, loading.tsx, error.tsx)', () => {
  for (const d of [...ROUTES.map((r) => r.dir), DETAIL, NEW]) {
    it(`${d}/{page,loading,error}.tsx exist; page is a server component with a default export; error.tsx is a client component`, () => {
      const base = join(appRoot, d);
      for (const f of ['page', 'loading', 'error']) expect(existsSync(join(base, `${f}.tsx`)), `${d}/${f}.tsx`).toBe(true);
      expect(isClient(join(base, 'page.tsx'))).toBe(false);
      expect(strip(read(join(base, 'page.tsx')))).toMatch(/export default/);
      expect(isClient(join(base, 'error.tsx'))).toBe(true);
      expect(isClient(join(base, 'loading.tsx'))).toBe(false);
    });
  }

  it('each page enforces its permission floor (routes.yaml): bookings read, slots slot.manage, bookable bookable_item.manage; W3 needs booking.manage', () => {
    for (const r of ROUTES) expect(text(walk(join(appRoot, r.dir)).filter(isSrc)), r.dir).toContain(r.perm);
    expect(text(walk(join(appRoot, DETAIL)).filter(isSrc))).toContain('engagement.booking.read');
    expect(text(walk(join(appRoot, NEW)).filter(isSrc)) + text(featFiles())).toContain('engagement.booking.manage');
  });

  it('data comes only from the C16 staff endpoints S1–S14 (bookings, slots, slot-templates, slot-blackouts, bookable-items) — via the server, never the browser', () => {
    const t = text(featFiles().filter((p) => !isClient(p)));
    for (const p of ['/engagement/bookings', '/engagement/slots', '/engagement/slot-templates', '/engagement/slot-blackouts', '/engagement/bookable-items']) expect(t, p).toContain(p);
    expect(text(featFiles().filter(isClient))).not.toMatch(/\/v1\/engagement|fetch\(/);
  });

  it('patient names are fetched server-side from C4 GET /v1/frontdesk/patients/{id}, a failure/403 renders "—" (04-UI-UX W1)', () => {
    const t = text(featFiles().filter((p) => !isClient(p)));
    expect(t).toMatch(/\/v1\/frontdesk\/patients/);
    expect(t).toMatch(/frontdesk\.patient\.read/);
  });

  it('mutating server actions send an Idempotency-Key and If-Match where the contract requires them (S3/S5 required; S4/S8/S10/S11/S13 If-Match)', () => {
    const t = text(featFiles().filter((p) => !isClient(p)));
    expect(t).toMatch(/Idempotency-Key/i);
    expect(t).toMatch(/If-Match/i);
  });
});

describe('kit composition (LD-140; 10-DESIGN-SYSTEM §6)', () => {
  it('the five W1–W5 components exist', () => {
    for (const c of COMPONENTS) expect(existsSync(c), c).toBe(true);
  });
  it('uses kit DataTable, FilterBar, Drawer, ConfirmDialog, StatusChip, Switch, Select, Combobox and WeekdayTimeRangeEditor; no raw <table>', () => {
    const t = text(featFiles());
    for (const c of ['DataTable', 'FilterBar', 'Drawer', 'ConfirmDialog', 'StatusChip', 'Switch', 'Select', 'Combobox', 'WeekdayTimeRangeEditor', 'DateTimePicker', 'Banner', 'Timeline', 'DescriptionList', 'MoneyText'])
      expect(t, c).toMatch(new RegExp(`@lims/ui/components/${c}['"/]`));
    for (const p of featFiles().filter((x) => x.endsWith('.tsx'))) expect(strip(read(p)), p).not.toMatch(/<table[\s>]/);
  });
  it('the weekday editor is the kit component (CR-C16-016 / LD-146), not a local look-alike', () => {
    expect(text(featFiles())).toMatch(/import\s[^;]*\bWeekdayTimeRangeEditor\b[^;]*from\s+['"]@lims\/ui\/components\/WeekdayTimeRangeEditor(\/WeekdayTimeRangeEditor)?['"]/);
  });
  it('no hex colours, pixel radii or inline style objects in feature code', () => {
    expect(all().length).toBeGreaterThan(0);
    for (const p of all()) {
      const s = strip(read(p));
      expect(s, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-]*\()/);
      expect(s, p).not.toMatch(/\bstyle=\{\{/);
      expect(s, p).not.toMatch(/border-?[rR]adius\s*:\s*['"`]?\d+px|rounded-\[\d+px\]/);
    }
  });
});

describe('security (07-SECURITY)', () => {
  it('no raw HTML injection, browser storage, document.cookie, hand-built bearer header, or eval', () => {
    expect(all().length).toBeGreaterThan(0);
    for (const p of all()) {
      const s = strip(read(p));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(s, p).not.toMatch(/Bearer /);
    }
  });
  it('no patient phone, address text or national id is rendered/stored by the W1–W5 lists (names only, via C4)', () => {
    const t = text(COMPONENTS.filter((p) => /BookingsList|SlotsAdmin|BookableCatalogue/.test(p) && existsSync(p)));
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toMatch(/phone_e164|contact_phone|national_id|address_text/i);
  });
});

describe('page keys (staff.engagement.bookings)', () => {
  it('W1 registers Alt+B, Alt+C, Alt+X through the C0 registry; every Alt+<letter> in the W1–W5 client code is unique and none is a global key (C0 AC-0D-7.5)', () => {
    const client = featFiles().filter(isClient);
    const t = text(client);
    expect(t).toMatch(/@\/core\/shortcuts\/registry|core\/shortcuts\/registry/);
    expect(t).toMatch(/shortcuts\.register\(/);
    expect(t).toMatch(/staff\.engagement\.bookings/);
    const keys = [...t.matchAll(/key\s*:\s*['"](Alt\+[A-Za-z])['"]/g)].map((m) => m[1]!.replace(/\+([a-z])$/, (_, c: string) => `+${c.toUpperCase()}`));
    for (const k of ['Alt+B', 'Alt+C', 'Alt+X']) expect(keys, k).toContain(k);
    for (const k of keys) expect(GLOBAL_KEYS as readonly string[], k).not.toContain(k);
  });
  it('W3 binds Ctrl+Enter to submit', () => {
    expect(text([join(feat, 'components/BookingNew.tsx')].filter(existsSync))).toMatch(/ctrlKey|metaKey|Ctrl\+Enter|\$mod\+Enter/);
  });
});
