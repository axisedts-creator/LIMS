// C16.T-Q4 — structure / security of app/(staff)/engagement/queue/** and features/engagement/{components,server}/ (W6 console, W7 setup).
// Sources: 02-TRD §3.4 tree, 04-UI-UX W6/W7 + §9.2 (TokenSlip, CR-C16-016), 03-APP-FLOW §7.2 (pairing: token never reaches the browser),
// 07-SECURITY (REQ-SEC-088 no raw HTML, REQ-SEC-068 token server-side), C0 04-UI-UX §4 (page keys never reuse a global key, AC-0D-7.5).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { GLOBAL_KEYS } from '../../../core/shortcuts/registry';

const app = fileURLToPath(new URL('../../../app/(staff)/engagement/queue/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : [];
const isSrc = (p: string) => /\.(ts|tsx)$/.test(p);
const appFiles = () => walk(app).filter(isSrc);
const featFiles = () => ['components', 'server'].flatMap((d) => walk(join(feat, d))).filter(isSrc);
const all = () => [...appFiles(), ...featFiles()];
const text = (fs: string[]) => fs.map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
const read = (p: string) => readFileSync(p, 'utf8');
const isClient = (p: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(read(p));

describe('route files (02-TRD §3.4: queue/page.tsx, queue/setup/page.tsx, each with loading.tsx / error.tsx)', () => {
  for (const dir of ['', 'setup/']) {
    it(`${dir || 'queue/'}{page,loading,error}.tsx exist`, () => {
      for (const f of ['page', 'loading', 'error']) expect(existsSync(join(app, dir, `${f}.tsx`)), `${dir}${f}.tsx`).toBe(true);
    });
    it(`${dir || 'queue/'}page.tsx is a server component with a default export; error.tsx is a client component; loading.tsx is not`, () => {
      const page = join(app, dir, 'page.tsx'), err = join(app, dir, 'error.tsx'), load = join(app, dir, 'loading.tsx');
      expect(existsSync(page) && existsSync(err) && existsSync(load)).toBe(true);
      expect(isClient(page)).toBe(false);
      expect(strip(read(page))).toMatch(/export default/);
      expect(isClient(err)).toBe(true);
      expect(isClient(load)).toBe(false);
    });
  }

  it('console page needs engagement.queue.operate and setup page needs engagement.queue.manage (one permission floor per operation, 08 A19 P-43)', () => {
    const c = existsSync(join(app, 'page.tsx')) ? strip(read(join(app, 'page.tsx'))) + text(featFiles().filter((f) => /server/.test(f))) : '';
    expect(c).toMatch(/engagement\.queue\.operate/);
    const s = existsSync(join(app, 'setup/page.tsx')) ? strip(read(join(app, 'setup/page.tsx'))) + text(featFiles().filter((f) => /server/.test(f))) : '';
    expect(s).toMatch(/engagement\.queue\.manage/);
  });

  it('console reads Q1a/Q2a/Q4 and setup reads Q1b/Q2b/Q8 — never the other floor\'s endpoint', () => {
    const t = text(featFiles().filter((f) => /server/.test(f)));
    for (const p of ['/queues', '/queue-counters', '/queue-tokens', '/queue-setup/queues', '/queue-setup/counters', '/queue-displays']) expect(t, p).toContain(p);
  });
});

describe('kit composition (04-UI-UX W6/W7, §9.2; no hand-rolled widgets)', () => {
  it('components exist: QueueConsole.tsx and QueueSetup.tsx', () => {
    expect(existsSync(join(feat, 'components/QueueConsole.tsx'))).toBe(true);
    expect(existsSync(join(feat, 'components/QueueSetup.tsx'))).toBe(true);
  });
  it('the slip is the kit TokenSlip (CR-C16-016), not a local look-alike', () => {
    expect(text(featFiles())).toMatch(/import\s[^;]*\bTokenSlip\b[^;]*from\s+['"]@lims\/ui\/components\/TokenSlip['"]/);
  });
  it('uses kit DataTable, Tabs, Select, Dialog, ConfirmDialog and KeyboardShortcutsDialog; no raw <table>', () => {
    const t = text(featFiles());
    for (const c of ['DataTable', 'Tabs', 'Select', 'Dialog', 'ConfirmDialog', 'KeyboardShortcutsDialog']) expect(t, c).toMatch(new RegExp(`@lims/ui/components/${c}`));
    for (const p of featFiles().filter((x) => x.endsWith('.tsx'))) expect(strip(read(p)), p).not.toMatch(/<table[\s>]/);
  });
});

describe('security (07-SECURITY; 03-APP-FLOW §7.2)', () => {
  it('no raw HTML injection, no browser storage / document.cookie, no hand-built bearer header, no eval', () => {
    expect(all().length).toBeGreaterThan(0);
    for (const p of all()) {
      const s = strip(read(p));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/); // "My counter" is remembered in memory only (W6)
      expect(s, p).not.toMatch(/Bearer /);
    }
  });
  it('no patient fields in any queue source (tokens carry only booking_id — AC-21.6)', () => {
    // ruling T-B6: queue sources only; W1-W3 (T-B6) legitimately carry patient fields (04-UI-UX.md:189,197)
    const q = all().filter((p) => /queue/i.test(p));
    expect(q.length).toBeGreaterThan(0);
    expect(text(q)).not.toMatch(/patient_(name|display_name|id)|phone_e164|\bphone\b|full_?name|registration_no/i);
  });
  it('the display token never reaches client code: no "use client" file mentions display_token / qdisp / NEXT_PUBLIC_', () => {
    for (const p of all().filter(isClient)) expect(strip(read(p)), p).not.toMatch(/display_token|qdisp|NEXT_PUBLIC_|setDisplayCookie/);
  });
  it('Pair this screen: server code calls Q8 (/queue-displays) then the T-Q5 setDisplayCookie; client code never fetches Q8 itself', () => {
    const server = featFiles().filter((p) => !isClient(p) && /server/.test(p));
    const t = text(server);
    expect(t).toMatch(/setDisplayCookie/);
    expect(t).toMatch(/\/queue-displays/);
    expect(t).toMatch(/['"]use server['"]/);
    expect(text(featFiles().filter(isClient))).not.toMatch(/\/queue-displays/);
  });
  it('the setup page ends in a redirect to /queue-display after pairing (03-APP-FLOW §7.2 step 5)', () => {
    expect(text(featFiles().filter((p) => !isClient(p) && /server/.test(p)))).toMatch(/redirect\(\s*['"]\/queue-display['"]\s*\)/);
  });
});

describe('polling and shortcuts', () => {
  it('client polling sends the background header so the C2 idle rule is unaffected (W6; 08 A25 D-206)', () => {
    expect(text(featFiles().filter(isClient))).toMatch(/x-lims-background|BACKGROUND_HEADER/i);
  });
  it('polls at 5000 ms', () => {
    expect(text(featFiles().filter(isClient))).toMatch(/5_?000/);
  });
  it('shortcuts are registered through the C0 registry under page id staff.engagement.queue', () => {
    const t = text(featFiles().filter(isClient));
    expect(t).toMatch(/@\/core\/shortcuts\/registry|core\/shortcuts\/registry/);
    expect(t).toMatch(/shortcuts\.register\(/);
    expect(t).toMatch(/staff\.engagement\.queue/);
  });
  it('every Alt+<letter> key declared in the queue sources is unique and none is a global key (C0 AC-0D-7.5)', () => {
    // ruling T-B6: queue sources only; registry checks are per page id, W1 (Alt+C) is a different page
    const t = text(featFiles().filter((p) => /queue/i.test(p)).filter(isClient));
    const keys =[...t.matchAll(/key\s*:\s*['"](Alt\+[A-Za-z])['"]/g)].map((m) => m[1]!.replace(/\+([a-z])$/, (_, c: string) => `+${c.toUpperCase()}`));
    for (const k of ['Alt+R', 'Alt+S', 'Alt+D', 'Alt+K', 'Alt+T', 'Alt+I']) expect(keys, k).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(GLOBAL_KEYS as readonly string[], k).not.toContain(k);
  });
});
