// C6-T07 — TemplateConfig JSON Schema + validation (02-TRD §6.5, `additionalProperties: false` everywhere; 07-SECURITY A11 "no URL fields").
// API ASSUMED (spec names the file domain/templates.ts and the schema, not exports): TEMPLATE_CONFIG_SCHEMA (JSON Schema object),
//   DEFAULT_TEMPLATE_CONFIG (a valid full config, snake_case keys as in the TRD), validateTemplateConfig(input: unknown) =>
//   { ok: true; config: TemplateConfig } | { ok: false; errors: { path: string; message: string }[] }   (pure; the handler maps !ok to reporting.template_invalid).
// Defaults filled by validation (TRD): results.show_method_line=true, results.group_by_package=true, signatories.max=2, qr.caption="Scan to verify", fonts.base_pt=9.
// Not asserted: the 11 header-field key names and signatories.label_registration (LD-27 moves the label to the signatory council).
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE_CONFIG, TEMPLATE_CONFIG_SCHEMA, validateTemplateConfig } from '../templates.js';

const base = (): any => structuredClone(DEFAULT_TEMPLATE_CONFIG);
const set = (path: string, value: unknown) => {
  const c = base();
  const keys = path.split('.');
  let o = c;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)!] = value;
  return c;
};
const ok = (c: unknown) => validateTemplateConfig(c).ok;
const paths = (c: unknown) => {
  const r: any = validateTemplateConfig(c);
  return r.ok ? [] : (r.errors as { path: string }[]).map((e) => e.path);
};

describe('defaults and shape', () => {
  it('DEFAULT_TEMPLATE_CONFIG is itself valid and JSON-serialisable', () => {
    expect(ok(DEFAULT_TEMPLATE_CONFIG)).toBe(true);
    expect(JSON.parse(JSON.stringify(DEFAULT_TEMPLATE_CONFIG))).toEqual(DEFAULT_TEMPLATE_CONFIG);
  });
  it('fills the documented defaults when the optional keys are absent', () => {
    const c = base();
    delete c.results.show_method_line;
    delete c.results.group_by_package;
    delete c.signatories.max;
    delete c.qr.caption;
    delete c.fonts.base_pt;
    const r: any = validateTemplateConfig(c);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.config.results.show_method_line).toBe(true);
    expect(r.config.results.group_by_package).toBe(true);
    expect(r.config.signatories.max).toBe(2);
    expect(r.config.qr.caption).toBe('Scan to verify');
    expect(r.config.fonts.base_pt).toBe(9);
  });
  it('does not mutate its input', () => {
    const c = base();
    delete c.fonts.base_pt;
    const before = JSON.stringify(c);
    validateTemplateConfig(c);
    expect(JSON.stringify(c)).toBe(before);
  });
  it('the schema closes every object (additionalProperties: false at every level) and has no URL-bearing keyword', () => {
    const open: string[] = [];
    const walk = (n: any, at: string) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'object' && n.additionalProperties !== false) open.push(at);
      for (const [k, v] of Object.entries(n)) walk(v, `${at}/${k}`);
    };
    walk(TEMPLATE_CONFIG_SCHEMA, '#');
    expect(open).toEqual([]);
    expect(JSON.stringify(TEMPLATE_CONFIG_SCHEMA)).not.toMatch(/"(format)"\s*:\s*"(uri|url|uri-reference|iri)"/);
  });
});

describe('unknown keys are rejected at every level', () => {
  for (const at of ['', 'page', 'page.margin_mm', 'letterhead', 'results', 'signatories', 'qr', 'fonts', 'narrative'])
    it(`extra key under "${at || 'root'}"`, () => {
      const c = base();
      const o = at ? at.split('.').reduce((a: any, k) => a[k], c) : c;
      o.evil_extra = true;
      expect(ok(c)).toBe(false);
      expect(paths(c).join(' ')).toMatch(/evil_extra|additional/i);
    });
  it('extra key under watermark', () => {
    expect(ok({ ...base(), watermark: { text: 'X', opacity: 0.1, evil_extra: 1 } })).toBe(false);
  });
  it('non-objects are rejected', () => {
    for (const v of [null, undefined, 'x', 1, [], true]) expect(ok(v), String(v)).toBe(false);
  });
  it('a JSON "__proto__" key is rejected and does not pollute Object.prototype', () => {
    const evil = JSON.parse(`{"__proto__":{"polluted":true},"page":${JSON.stringify(base().page)}}`);
    const r = validateTemplateConfig(evil);
    expect(({} as any).polluted).toBeUndefined();
    expect(r.ok).toBe(false);
  });
});

describe('numeric and length bounds (TRD §6.5)', () => {
  const edge = (path: string, good: unknown[], bad: unknown[]) =>
    it(path, () => {
      for (const v of good) expect(ok(set(path, v)), `${path}=${JSON.stringify(v)} valid`).toBe(true);
      for (const v of bad) expect(ok(set(path, v)), `${path}=${JSON.stringify(v)} invalid`).toBe(false);
    });
  edge('page.size', ['A4', 'Letter'], ['Legal', 'a4', '', 5, null]);
  edge('page.margin_mm.top', [5, 80], [4, 81, '25', null]);
  edge('page.margin_mm.bottom', [5, 80], [4.9, 81]);
  edge('page.margin_mm.left', [5, 40], [4, 41]);
  edge('page.margin_mm.right', [5, 40], [4, 41]);
  edge('letterhead.plain_reserve_top_mm', [0, 80], [-1, 81]);
  edge('letterhead.plain_reserve_bottom_mm', [0, 80], [-1, 81]);
  edge('letterhead.header_asset', ['branding', 'none'], ['http://169.254.169.254/x', 'https://x.example/h.png', 'data:image/png;base64,AAAA', '', 'Branding']);
  edge('letterhead.footer_asset', ['branding', 'none'], ['http://169.254.169.254/x', '../../etc/passwd']);
  edge('signatories.mode', ['approvers', 'nominated'], ['both', '', 'Approvers']);
  edge('signatories.max', [1, 4], [0, 5, 2.5]);
  edge('qr.size_mm', [15, 35], [14, 36]);
  edge('qr.caption', ['', 'x'.repeat(60)], ['x'.repeat(61), 5]);
  edge('fonts.base_pt', [7, 11], [6, 12]);
  edge('narrative.show_images_grid_columns', [1, 3], [0, 4]);
  edge('contact_strip_extra', ['x'.repeat(300)], ['x'.repeat(301), 5]);
  edge('watermark', [{ text: 'x'.repeat(40), opacity: 0.05 }, { text: 'SYNTHETIC', opacity: 0.3 }], [
    { text: 'x'.repeat(41), opacity: 0.1 }, { text: 'S', opacity: 0.04 }, { text: 'S', opacity: 0.31 }, { text: 'S' }, { opacity: 0.1 }, { text: 5, opacity: 0.1 },
  ]);
  edge('disclaimers', [[], Array(5).fill('x'), ['x'.repeat(200)]], [Array(6).fill('x'), ['x'.repeat(201)], [1], 'x']);
  it('boolean switches accept only booleans', () => {
    for (const p of ['results.show_method_line', 'results.show_units_column', 'results.group_by_package', 'results.page_break_before_department', 'results.show_department_approved_by', 'signatories.show_signature_images', 'qr.enabled']) {
      expect(ok(set(p, true)), p).toBe(true);
      expect(ok(set(p, false)), p).toBe(true);
      expect(ok(set(p, 'yes')), `${p}='yes'`).toBe(false);
      expect(ok(set(p, 1)), `${p}=1`).toBe(false);
    }
  });
});

describe('header_fields: ordered subset of the 11 header fields', () => {
  it('accepts the default list; rejects unknown entries, duplicates and more than 11', () => {
    const hf = base().header_fields;
    if (hf === undefined) return; // optional in the schema: nothing further to assert
    expect(Array.isArray(hf)).toBe(true);
    expect(hf).toHaveLength(11);
    expect(new Set(hf).size).toBe(11);
    expect(ok(set('header_fields', hf.slice(0, 4)))).toBe(true);
    expect(ok(set('header_fields', [...hf].reverse()))).toBe(true);
    expect(ok(set('header_fields', [...hf.slice(0, 3), 'not_a_field']))).toBe(false);
    expect(ok(set('header_fields', [hf[0], hf[0]]))).toBe(false);
    expect(ok(set('header_fields', [...hf, hf[0]]))).toBe(false);
    expect(ok(set('header_fields', ['http://169.254.169.254/']))).toBe(false);
  });
});

describe('errors', () => {
  it('report a JSON-pointer-ish path for the offending field, one entry per problem', () => {
    const c = set('page.margin_mm.top', 4);
    const r: any = validateTemplateConfig(c);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.map((e: any) => e.path).join(' ')).toMatch(/margin_mm.*top|top/);
    for (const e of r.errors) expect(typeof e.message).toBe('string');
  });
  it('never echo a rejected value back (config may be tenant-supplied text)', () => {
    const secret = 'SECRET-VALUE-SHOULD-NOT-ECHO';
    const r: any = validateTemplateConfig(set('letterhead.header_asset', secret));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.errors)).not.toContain(secret);
  });
});
