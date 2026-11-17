// C6-T25 — static guards for message templates & channel accounts admin (M1, M2, C1-C3): 05-SCHEMA §2.8/§2.9 + §6 grants, REQ-SEC-024 tenant predicate,
// REQ-SEC-128 secret reference only, 08 A13 P-8 E1 (callback token never stored in core.idempotency_keys), 07-SECURITY test 8h.
// The sources are DISCOVERED (the file names are the writer's choice): every non-test file under handlers/, service/, repository/ that holds one of the five
// operationIds, `message_template_texts` or `rotateChannel...`, minus the pre-existing read-only users of channel_accounts (delivery.repo, records.repo).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPS = ['listMessageTemplates', 'upsertMessageTemplateText', 'listChannelAccounts', 'upsertChannelAccount', 'rotateChannelCallbackToken'];
const PRE_EXISTING = new Set(['repository/delivery.repo.ts', 'repository/records.repo.ts']);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = (dir: string): string[] => (existsSync(join(R, dir)) ? readdirSync(join(R, dir)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`) : []);
const sources = ['handlers', 'service', 'repository'].flatMap(files).filter((f) => !PRE_EXISTING.has(f))
  .map((f) => ({ f, text: readFileSync(join(R, f), 'utf8') }))
  .filter(({ text }) => OPS.some((o) => text.includes(o)) || /message_template_texts|reporting\.channel_accounts/.test(text));
const all = sources.map((s) => code(s.text)).join('\n');
/** Every string/template literal that holds SQL touching the three tables. */
const sql = [...all.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2]!).filter((x) => /\breporting\.(message_template_texts|channel_accounts|g_message_templates)\b/i.test(x));

describe('C6-T25 sources (non-test)', () => {
  it('a handler file holds all five operationIds and is wired into the manifest', () => {
    const h = sources.filter((s) => s.f.startsWith('handlers/')); expect(h.length, 'handlers/*.ts with the five operationIds').toBeGreaterThan(0);
    for (const o of OPS) expect(h.some((s) => s.text.includes(o)), o).toBe(true);
    const idx = readFileSync(join(R, 'index.ts'), 'utf8'); expect(h.every((s) => idx.includes(s.f.replace(/^handlers\//, 'handlers/').replace(/\.ts$/, '.js'))), 'index.ts imports the handler file').toBe(true);
  });
  it('a service and a repository exist (handlers never run SQL)', () => {
    expect(sources.some((s) => s.f.startsWith('service/')), 'service/').toBe(true); expect(sources.some((s) => s.f.startsWith('repository/')), 'repository/').toBe(true);
    for (const s of sources.filter((x) => x.f.startsWith('handlers/') || x.f.startsWith('service/'))) expect(code(s.text), s.f).not.toMatch(/\.query\s*\(/);
  });
  it('no outbound access (approval and callbacks are recorded manually, nothing is called)', () => {
    expect(all).not.toMatch(/\bfetch\s*\(|node:https?|\baxios\b/);
  });
});

describe('C6-T25 secrets', () => {
  it('nothing here touches core.idempotency_keys or the idempotency module (C3 is x-idempotency none: the callback URL is shown once, never replayed)', () => {
    expect(all).not.toMatch(/idempotency_keys|createIdempotency|core\/idempotency/i);
  });
  it('the callback token comes from domain/tokens issueToken("callback") (shared crypto, 256-bit) and only its hash is bound', () => {
    expect(all).toMatch(/issueToken\s*\(\s*['"]callback['"]\s*\)/); expect(all).not.toMatch(/Math\.random|randomUUID|randomBytes\s*\(/);
  });
  it('the token is never logged or put in an audit/metric call', () => {
    for (const m of all.matchAll(/\b(?:log|logger|audit|metrics)\b[\w.]*\([^)]*\)/g)) expect(m[0], m[0]).not.toMatch(/token|callback_url|callbackUrl/i);
  });
  it('no plaintext secret column or field: only secret_ref is stored / selected', () => {
    for (const s of sql) expect(s, s).not.toMatch(/\b(secret_value|api_key|password|auth_token|client_secret)\b/i);
  });
});

describe('C6-T25 SQL', () => {
  it('statements exist', () => expect(sql.length).toBeGreaterThan(0));
  it('static text: no template-literal interpolation or string concatenation into a statement', () => {
    for (const s of sql) expect(s, s).not.toMatch(/\$\{|'\s*\+|\+\s*'/);
  });
  it('every SELECT / UPDATE on a tenant table carries an explicit tenant predicate bound to a parameter (REQ-SEC-024)', () => {
    for (const s of sql.filter((x) => /^\s*(select|update)/i.test(x) && !/g_message_templates/i.test(x.replace(/\bwhere\b[\s\S]*$/i, '')) )) expect(s, s).toMatch(/\btenant_id\s*=\s*\$\d+/);
  });
  it('INSERTs into tenant tables name tenant_id', () => { for (const s of sql.filter((x) => /^\s*insert\s+into\s+reporting\.(message_template_texts|channel_accounts)/i.test(x))) expect(s, s).toMatch(/\btenant_id\b/); });
  it('nothing deletes rows (lims_app has no DELETE grant)', () => { for (const s of sql) expect(s).not.toMatch(/\bdelete\s+from\b/i); });
  it('g_message_templates is read-only here (global registry: seeds only, SELECT grant only)', () => {
    for (const s of sql.filter((x) => /g_message_templates/i.test(x))) expect(s, s).toMatch(/^\s*select\b/i);
  });
  it('UPDATEs of message_template_texts / channel_accounts use optimistic locking (version = version + 1)', () => {
    const upd = sql.filter((x) => /^\s*update\s+reporting\.(message_template_texts|channel_accounts)\b/i.test(x)); expect(upd.length).toBeGreaterThan(0);
    for (const s of upd) expect(s, s).toMatch(/\bversion\s*=\s*(?:\w+\.)?version\s*\+\s*1/i);
  });
  it('the token-rotation UPDATE is guarded by the expected version (`version = $n`) so a double submit matches no row', () => {
    const rot = sql.filter((x) => /^\s*update\s+reporting\.channel_accounts\b/i.test(x) && /callback_token_sha256\s*=/i.test(x.replace(/\bwhere\b[\s\S]*$/i, '')));
    expect(rot.length, 'a callback_token_sha256 UPDATE').toBeGreaterThan(0);
    for (const s of rot) expect(s.replace(/^[\s\S]*?\bwhere\b/i, ''), s).toMatch(/\bversion\s*=\s*\$\d+/i);
  });
});
