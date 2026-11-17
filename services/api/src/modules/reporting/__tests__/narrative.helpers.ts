// C6-T17 test helpers (not a test file). Synthetic data only. Builds on outsourced.helpers.ts (fake tx incl. narrative_versions / narrative_templates)
// and narrative-image.helpers.ts (NARR_1 draft, NARR_SIGNED, NARR_B of tenant B, imageRow).
// The fake models `col = $n` / `col = 'lit'` filters, VALUES inserts and `SET col = $n | version + 1 | COALESCE($n, col) | now()` updates ONLY:
// the implementation must not rely on joins, `= ANY($n)`, ORDER BY semantics or aggregate SQL (look rows up by id / (narrative, version_no)).
import { createHash } from 'node:crypto';
import { CENTRE_1, ITEM_1, MEM, NOW, ORDER_1, REPORT_1, TENANT_A, TENANT_B, USER, idN, makeApiCtx, makeDb, makeStorage, world, type Row } from './outsourced.helpers.js';
import { NARR_1, NARR_B, NARR_SIGNED, imageRow, narratives } from './narrative-image.helpers.js';

export { NARR_1, NARR_B, NARR_SIGNED, ITEM_1, REPORT_1, CENTRE_1, ORDER_1, TENANT_A, TENANT_B, USER, MEM, NOW, idN, imageRow };
export const TEST_XRAY = idN(0x7001);            // catalog test of the seeded narratives
export const TPL_TEST = idN(0x5001);             // tenant A template bound to TEST_XRAY (kind xray)
export const TPL_KIND = idN(0x5002);             // tenant A generic template (kind xray, no test)
export const TPL_B = idN(0x50b1);                // tenant B template
export const VERSION_ID = (n: number) => idN(0x6000 + n);
export const TEST_NAME = 'Synthetic chest X-ray';
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const SECTIONS = [
  { key: 'clinical_history', heading: 'Clinical history', required: false, default_html: '<p>Clinical history: </p>' },
  { key: 'technique', heading: 'Technique', required: false, default_html: '<p>PA view.</p>' },
  { key: 'findings', heading: 'Findings', required: true, default_html: '<p></p>' },
  { key: 'impression', heading: 'Impression', required: true, default_html: '<p></p>' },
];
const tpl = (tenant: string, id: string, code: string, o: Row = {}): Row =>
  ({ tenant_id: tenant, id, code, name: `Synthetic ${code}`, kind: 'xray', test_id: null, sections: SECTIONS, is_active: true, version: 1, created_by: USER, updated_by: USER, ...o });
export function templates(): Row[] {
  return [tpl(TENANT_A, TPL_TEST, 'XRAY_CHEST', { test_id: TEST_XRAY }), tpl(TENANT_A, TPL_KIND, 'XRAY_GENERIC'), tpl(TENANT_B, TPL_B, 'XRAY_B', { test_id: TEST_XRAY })];
};

/** A narrative_versions row. `sections` is the stored form [{key, html}] (headings come from the template). */
export function versionRow(narrativeId: string, no: number, o: Row = {}): Row {
  return {
    tenant_id: TENANT_A, id: VERSION_ID(no + (narrativeId === NARR_SIGNED ? 0x100 : 0)), centre_id: CENTRE_1, narrative_report_id: narrativeId, version_no: no, status: 'draft', template_id: TPL_TEST,
    sections: [{ key: 'findings', html: '<p>Synthetic finding.</p>' }, { key: 'impression', html: '<p>Synthetic impression.</p>' }],
    image_file_ids: [], created_by: USER, updated_by: USER, ...o,
  };
}
export const signedV1 = (narrativeId = NARR_SIGNED, o: Row = {}) => versionRow(narrativeId, 1, {
  status: 'signed', signed_by_membership_id: idN(0x3102), signed_at: '2026-11-07T10:00:00.000Z', content_sha256: sha('v1'), ...o });

export const MEM_SIGNER = idN(0x3102);
export function seedAll(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  const w = world() as Record<string, Row[]>;
  return {
    ...w,
    // tenant-A item with one narrative requirement, not yet ready
    report_order_items: [{ tenant_id: TENANT_A, report_id: REPORT_1, order_item_id: ITEM_1, order_id: ORDER_1, centre_id: CENTRE_1, requires_lab: false, requires_narrative: true, requires_outsourced: false, narrative_ready: false, amendment_pending: false, item_status: 'active' }],
    narrative_reports: narratives().map((n) => (n.id === NARR_1 ? { ...n, test_id: TEST_XRAY, current_version_no: 1, version: 1 } : n.id === NARR_SIGNED ? { ...n, test_id: TEST_XRAY, current_version_no: 1, signed_version_no: 1, version: 3 } : n)),
    narrative_templates: templates(),
    narrative_versions: [versionRow(NARR_1, 1), signedV1()],
    g_cs_reasons: [...(w['g_cs_reasons'] ?? []), { set_name: 'narrative_amend_reasons', code: 'transcription_error', display: 'Transcription error', sort_order: 1 },
      { set_name: 'narrative_amend_reasons', code: 'clinical_correction', display: 'Clinical correction', sort_order: 2 }],
    ...extra,
  };
}

export const REASONS = ['transcription_error', 'clinical_correction'];
export function env(operationId: string, manifest: any, seed: Record<string, Row[]> = seedAll(), over: Record<string, unknown> = {}) {
  const db = makeDb(seed as any); const storage = makeStorage();
  const roleCalls: Array<{ permission: string; centreId?: string }> = []; const catalogCalls: unknown[] = [];
  const denied: { error?: () => Error } = {};
  const ports = {
    IdentityPort: { assertRole: async (_c: unknown, req: any) => { roleCalls.push(req); if (denied.error) throw denied.error(); } },
    CatalogPort: { getTest: async (_c: unknown, req: any) => { catalogCalls.push(req); return { id: req.testId, name: TEST_NAME, code: 'XRCH', workflowType: 'narrative', isActive: true, revision: 1, analytes: [] }; } },
  };
  const c = makeApiCtx(db, storage, { ports, ...over });
  const noop = { info() {}, warn() {}, error() {} };
  return { db, storage, roleCalls, catalogCalls, denied, ...c, hctx: { ...c.ctx, operationId, clientIp: '203.0.113.9', log: noop, manifest } };
}
export const ifm = (v: unknown) => ({ 'if-match': `"${v}"` });
export const idem = (k = 'k-0001') => ({ 'idempotency-key': k });

/** Text that must never survive N3 (REQ-SEC-088 / AC-05.2). Each entry carries the SAFE text 'KEEP-ME' so a "strip everything" sanitiser is also visible. */
export const XSS_CORPUS: Array<[string, string]> = [
  ['script tag', '<p>KEEP-ME</p><script>alert(1)</script>'],
  ['script, mixed case', '<ScRiPt>alert(1)</sCrIpT><p>KEEP-ME</p>'],
  ['nested script split', '<p>KEEP-ME</p><scr<script>ipt>alert(1)</scr</script>ipt>'],
  ['img onerror', '<p>KEEP-ME</p><img src=x onerror=alert(1)>'],
  ['img onerror quoted + newline', '<p>KEEP-ME</p><img src="x"\nonerror\n=\n"alert(1)">'],
  ['onclick on p', '<p onclick="alert(1)">KEEP-ME</p>'],
  ['onmouseover on strong', '<strong onmouseover=alert(1)>KEEP-ME</strong>'],
  ['javascript: href', '<a href="javascript:alert(1)">KEEP-ME</a>'],
  ['javascript: href, entity-encoded', '<a href="&#106;avascript:alert(1)">KEEP-ME</a>'],
  ['javascript: href, tab-split', '<a href="java\tscript:alert(1)">KEEP-ME</a>'],
  ['vbscript: href', '<a href="vbscript:msgbox(1)">KEEP-ME</a>'],
  ['data:text/html href', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">KEEP-ME</a>'],
  ['svg onload', '<p>KEEP-ME</p><svg onload=alert(1)><circle r=1></circle></svg>'],
  ['svg script', '<p>KEEP-ME</p><svg><script>alert(1)</script></svg>'],
  ['iframe', '<p>KEEP-ME</p><iframe src="https://evil.example/x"></iframe>'],
  ['object / embed', '<p>KEEP-ME</p><object data="x.swf"></object><embed src="x.swf">'],
  ['style block', '<style>@import "https://evil.example/x.css";</style><p>KEEP-ME</p>'],
  ['style attr with javascript url', '<p style="background:url(javascript:alert(1))">KEEP-ME</p>'],
  ['form + button', '<form action="https://evil.example/p"><input name=a><button formaction="https://evil.example">x</button></form><p>KEEP-ME</p>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>KEEP-ME</p>'],
  ['base + link', '<base href="https://evil.example/"><link rel=stylesheet href="https://evil.example/x.css"><p>KEEP-ME</p>'],
  ['math / mXSS', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>KEEP-ME</style></mglyph></table></mtext></math>'],
  ['noscript mXSS', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">KEEP-ME</p></noscript>'],
  ['external image (no external URLs)', '<p>KEEP-ME</p><img src="https://evil.example/pixel.png">'],
  ['srcdoc / formaction attrs', '<p>KEEP-ME</p><a href="#" formaction="javascript:alert(1)" srcdoc="<script>alert(1)</script>">x</a>'],
  ['dom clobbering id/name', '<p>KEEP-ME</p><img name="getElementById" id="cookie" src=x>'],
];
/** Anything in this list in the STORED or RETURNED html is an XSS vector. */
export const DANGEROUS = /<\s*(script|iframe|object|embed|svg|math|style|form|input|button|meta|link|base|noscript|template|frame|applet)\b|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text|srcdoc|formaction|https?:\/\/evil\.example|<\s*img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i;
export const SAFE_HTML = '<p>Synthetic <strong>finding</strong> with <em>emphasis</em>.</p><ul><li>one</li><li>two</li></ul>';

export const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
/** Stored sections of a version row, whatever the repo used to bind jsonb (object or JSON string). */
export const storedSections = (r: Row): Array<{ key: string; heading?: string; html: string }> => asJson(r['sections']);
/** uuid[] as bound by the repo: a JS array or a Postgres literal `{a,b}`. */
export const storedIds = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);
export const versionsOf = (db: ReturnType<typeof makeDb>, narrativeId: string) => db.store['narrative_versions']!.filter((v) => v['narrative_report_id'] === narrativeId).sort((a, b) => a['version_no'] - b['version_no']);
export const narrativeRow = (db: ReturnType<typeof makeDb>, id: string) => db.store['narrative_reports']!.find((r) => r['id'] === id)!;
