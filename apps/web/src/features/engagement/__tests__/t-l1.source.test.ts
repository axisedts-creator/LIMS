// C16.T-L1 — structure / security of app/(staff)/engagement/app-access/** (W8) and of the T-L1 API files.
// Sources: 02-TRD §3.4 tree, §4.3 (bytea HMACs, no decode(..,'hex')), 03-APP-FLOW W8, 06-PLAN row T-L1, contracts/routes.yaml (staff.engagement.app_access, permission engagement.link.read),
// 07-SECURITY (log denylist: link codes never in logs/URLs; REQ-SEC-088 no raw HTML), LD-140 (kit components and token names only).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const appRoot = fileURLToPath(new URL('../../../app/(staff)/engagement/app-access/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const api = fileURLToPath(new URL('../../../../../../services/api/src/modules/engagement/', import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] =>
  existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : [];
const read = (p: string) => readFileSync(p, 'utf8');
const isClient = (p: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(read(p));
const isSrc = (p: string) => /\.(ts|tsx)$/.test(p);

const DETAIL = join(appRoot, '[patient_id]');
const COMPONENT = join(feat, 'components', 'AppAccess.tsx');
const appFiles = () => walk(appRoot).filter(isSrc);
const wFiles = () => [...appFiles(), ...(existsSync(COMPONENT) ? [COMPONENT] : [])];
const text = (fs: string[]) => fs.map((p) => strip(read(p))).join('\n');

describe('route files (route staff.engagement.app_access = /engagement/app-access/{patient_id})', () => {
  for (const f of ['page', 'loading', 'error']) {
    it(`app-access/[patient_id]/${f}.tsx exists; page is a server component with a default export; error.tsx is a client component`, () => {
      const p = join(DETAIL, `${f}.tsx`);
      expect(existsSync(p), p).toBe(true);
      if (f === 'page') { expect(isClient(p)).toBe(false); expect(strip(read(p))).toMatch(/export default/); }
      if (f === 'error') expect(isClient(p)).toBe(true);
      if (f === 'loading') expect(isClient(p)).toBe(false);
    });
  }
  it('the page enforces engagement.link.read before any API call (else shell not-found), and the issue action needs engagement.link.issue; revoke actions engagement.link.revoke', () => {
    const t = text(appFiles()) + text(walk(join(feat, 'server')).filter(isSrc));
    expect(t).toContain('engagement.link.read');
    expect(t).toContain('engagement.link.issue');
    expect(t).toContain('engagement.link.revoke');
    expect(strip(read(join(DETAIL, 'page.tsx')))).toMatch(/requirePerm\(\s*['"]engagement\.link\.read['"]/);
  });
  it('data comes only from L1-L4 (link-codes, patients/{id}/app-links, app-links/{id}/revoke) and the C4 patient name — through the server, never the browser', () => {
    const server = text(walk(join(feat, 'server')).filter(isSrc).filter((p) => !isClient(p)));
    for (const p of ['/engagement/link-codes', '/app-links']) expect(server, p).toContain(p);
    expect(server).toMatch(/\/v1\/frontdesk\/patients/);
    expect(text(wFiles().filter(isClient))).not.toMatch(/\/v1\/engagement|fetch\(/);
  });
  it('mutating server actions send If-Match for the two revoke operations; issue is not replayed (no Idempotency-Key requirement) and its response is never cached', () => {
    const server = text(walk(join(feat, 'server')).filter(isSrc).filter((p) => !isClient(p)));
    expect(server).toMatch(/If-Match/i);
    expect(server).toMatch(/no-store|cache:\s*['"]no-store['"]|revalidate:\s*0/);
  });
});

describe('kit composition (LD-140)', () => {
  it('AppAccess.tsx exists and exports AppAccess and CodeSlip', () => {
    expect(existsSync(COMPONENT)).toBe(true);
    const t = strip(read(COMPONENT));
    expect(t).toMatch(/export (function|const) AppAccess\b/); expect(t).toMatch(/export (function|const) CodeSlip\b/);
    expect(isClient(COMPONENT)).toBe(true);
  });
  it('uses kit components (Dialog or ConfirmDialog, StatusChip, EmptyState/Banner, PrintFrame for the slip); no raw <table>', () => {
    const t = text(wFiles());
    for (const c of ['StatusChip', 'PrintFrame']) expect(t, c).toMatch(new RegExp(`@lims/ui/components/${c}['"/]`));
    expect(t).toMatch(/@lims\/ui\/components\/(Dialog|ConfirmDialog)['"/]/);
    for (const p of wFiles().filter((x) => x.endsWith('.tsx'))) expect(strip(read(p)), p).not.toMatch(/<table[\s>]/);
  });
  it('no hex colours, pixel radii or inline style objects', () => {
    expect(wFiles().length).toBeGreaterThan(0);
    for (const p of wFiles()) {
      const s = strip(read(p));
      expect(s, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-]*\()/);
      expect(s, p).not.toMatch(/\bstyle=\{\{/);
      expect(s, p).not.toMatch(/border-?[rR]adius\s*:\s*['"`]?\d+px|rounded-\[\d+px\]/);
    }
  });
});

describe('security (07-SECURITY: link codes never in logs, URLs or storage; REQ-SEC-088)', () => {
  it('no raw HTML injection, browser storage, document.cookie, hand-built bearer header, console output or eval in W8 code', () => {
    expect(wFiles().length).toBeGreaterThan(0);
    for (const p of wFiles()) {
      const s = strip(read(p));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(s, p).not.toMatch(/Bearer /);
      expect(s, p).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
  });
  it('the code is not passed through the URL: no router.push/replace, searchParams or redirect carrying it', () => {
    const t = text(wFiles());
    expect(t).not.toMatch(/(push|replace|redirect)\([^)]*\bcode\b/);
    expect(t).not.toMatch(/searchParams[^;\n]*\bcode\b/);
  });
});

describe('T-L1 API files (02-TRD §3.4: service/link.service.ts, repository/linkCodes.repo.ts, repository/consents.repo.ts)', () => {
  const FILES = ['service/link.service.ts', 'repository/linkCodes.repo.ts', 'repository/consents.repo.ts'].map((f) => join(api, f));
  it('the three files exist', () => { for (const f of FILES) expect(existsSync(f), f).toBe(true); });
  it("HMACs are Buffers end to end: no decode(.., 'hex'), no .toString('hex') / hex-string parameter for code_hmac, bound_phone_hmac, record_phone_hmac (08 A2.4 / A5.5)", () => {
    for (const f of FILES.filter(existsSync)) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/decode\s*\(/i);
      expect(s, f).not.toMatch(/['"]hex['"]/);
    }
  });
  it('the service never logs or emits the plaintext code, phone or name (no console.*, no log call with them) and reads the keys from the module config key files', () => {
    const f = FILES[0]!;
    if (!existsSync(f)) return expect(existsSync(f)).toBe(true);
    const s = strip(read(f));
    expect(s).not.toMatch(/console\./);
    expect(s).not.toMatch(/ctx\.log\.\w+\([^)]*\b(code|phone|name|display_name)\b/);
    expect(s).toMatch(/linkHmacKeyFile|LINK_HMAC_KEY_FILE|phoneHmacKeyFile|PHONE_HMAC_KEY_FILE|phoneHmac|linkCodeHmac/);
  });
  it('the repositories use parameterised SQL only (no template-literal interpolation of values into SQL)', () => {
    for (const f of FILES.slice(1).filter(existsSync)) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/\$\{[^}]*\}[^`]*\b(WHERE|VALUES|SET)\b|\b(WHERE|VALUES|SET)\b[^`]*\$\{(?!\s*(cols?|columns?|COLUMNS?|[A-Z_]+)\s*\})/);
    }
  });
});
