// C3.T-38 docs-review tests. Spec: 04-UI-UX §1 (in-app help button links to features/catalog/help/<screen>.md), §3 (privileged-action text, tax disclaimer,
// banned word), §4 (screen copy), §7 (integration guide docs/manual/catalog/integration.md + runbook entries); 05-DoD §3.8 (manual pages + in-app help for EVERY screen),
// §1.9; plan row T-38 "one page per screen; integration guide (04-UI-UX §7)".
// ASSUMED naming (dispute if wrong; same rule as analytics AN-T24): help file = apps/web/src/features/catalog/help/<last dot-segment of the screen's helpKey>.md;
// SCR-07/SCR-08 have no helpKey in the code yet, so they are fixed as analyte.md / ranges.md; SCR-19 shares helpKey catalog.imports (imports.md covers both).
// Manual = docs/manual/catalog/README.md + integration.md + one <same slug>.md per screen (each names its route). Screens are the fixed SCREENS table below UNION every
// helpKey="catalog.*" found in the components (a new screen without help fails here).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const feat = join(root, 'apps/web/src/features/catalog');
const helpDir = join(feat, 'help');
const manualDir = join(root, 'docs/manual/catalog');
const WORD = ['commis', 'sion'].join(''); // never spell the banned word in this file (04-UI-UX §3 copy rule, 04 L19)
const DISCLAIMER = 'Tax treatment of lab services is pending confirmation by your auditor.';

const raw = (p: string) => readFileSync(p, 'utf8');
// normalise markdown noise so copy checks survive **bold**, `code`, NBSP and line wraps
const norm = (s: string) => s.replace(/[`*]/g, '').replace(/ /g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
const helpOf = (k: string) => norm(raw(join(helpDir, `${k}.md`)));
const manualOf = (k: string) => norm(raw(join(manualDir, `${k}.md`)));
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);
const allManual = () => mdIn(manualDir).map((n) => norm(raw(join(manualDir, n)))).join('\n');

interface Screen { slug: string; scr: string; route: string; perm: string; must: [string, RegExp][] }
const SCREENS: Screen[] = [
  { slug: 'home', scr: 'SCR-01', route: '/catalog', perm: 'catalog.test.read', must: [
    ['Needs attention section', /needs attention/i], ['health report', /health report/i], ['tax default configured', /tax default configured/i],
    ['alternative permission', /catalog\.price_list\.read/] ] },
  { slug: 'departments', scr: 'SCR-02', route: '/catalog/departments', perm: 'catalog.test.read', must: [
    ['code regex', /\^\[A-Z0-9\]\[A-Z0-9_\]\{0,31\}\$/], ['report order 0-9999', /0\s*[–-]\s*9999/], ['code read-only after create', /read-only after|cannot be changed|create only|only when (you )?creat/i],
    ['duplicate code message', /This code is already used\./] ] },
  { slug: 'specimens', scr: 'SCR-03', route: '/catalog/specimens', perm: 'catalog.test.read', must: [
    ['containers tab', /container/i], ['report label printed as Specimen:', /Specimen:/], ['cap colour is display only', /cap colou?r[^.]*display only|display only[^.]*cap colou?r/i] ] },
  { slug: 'methods', scr: 'SCR-04', route: '/catalog/methods', perm: 'catalog.test.read', must: [
    ['printed as METHOD :', /METHOD :/], ['name max 120', /120/] ] },
  { slug: 'units', scr: 'SCR-05', route: '/catalog/units', perm: 'catalog.test.read', must: [
    ['global units read-only', /Provided by the system/], ['value sets tab', /value sets?/i], ['ordered set', /ordered/i], ['in-use set order/delete locked', /in use/i], ['unit display max 32', /32/] ] },
  { slug: 'tests', scr: 'SCR-06', route: '/catalog/tests', perm: 'catalog.test.read', must: [
    ['workflow types', /Narrative report/], ['workflow Outsourced', /Outsourced/], ['workflow change blocked after first published analyte version', /first published analyte version/i],
    ['tabs', /TAT targets/], ['TAT segment wording', /Within lab/], ['TAT alerts come later', /Quality module/], ['specimens max 10 rows', /10 rows|ten rows/i],
    ['instrument codes privileged + edit in Instruments', /Edit mappings in Instruments/], ['instrument-code permission', /catalog\.instrument_code_map\.manage/], ['reorder shortcut', /Alt\s*\+\s*(↑|Up)/i] ] },
  { slug: 'analyte', scr: 'SCR-07', route: '/catalog/tests/', perm: 'catalog.test.read', must: [
    ['versioned vs not versioned', /not versioned/i], ['create new version / draft', /Create new version/], ['publish permission', /catalog\.reference_range\.publish/], ['manage permission', /catalog\.test\.manage/],
    ['two-step lock text', /Requires two-step verification/], ['publish: change reason', /change reason/i], ['unit/method change warning', /old reference ranges will no longer apply/i],
    ['formula autocomplete shortcut', /Ctrl\s*\+\s*Space/], ['formula limit', /500/], ['analyte code regex', /\^\[A-Z\]\[A-Z0-9_\]\{0,31\}\$/], ['Ctrl+Enter publishes', /Ctrl\s*\+\s*Enter/] ] },
  { slug: 'ranges', scr: 'SCR-08', route: '/catalog/tests/', perm: 'catalog.test.read', must: [
    ['age boundary rule copy', /Lower age is included, upper age is not\./], ['age example', /0\s*[–-]\s*18 years covers patients until the day before their 18th birthday/],
    ['no range copy', /No reference range/], ['preview panel', /preview/i], ['critical limits tab', /critical/i], ['publish permission', /catalog\.reference_range\.publish/],
    ['typed confirmation of analyte code', /typed? (the )?(analyte )?code|type the (analyte )?code|typed confirmation/i], ['draft-only editing', /draft/i] ] },
  { slug: 'panels', scr: 'SCR-09', route: '/catalog/panels', perm: 'catalog.test.read', must: [
    ['package copy', /Packages are priced as one item\. Component prices are not added up\./], ['members max 100', /100/], ['expanded tests preview', /Expanded tests/],
    ['sex restriction', /sex restriction/i], ['kind create only', /Kind[^.]*(create only|cannot be changed)|(create only|cannot be changed)[^.]*kind/i] ] },
  { slug: 'comment_codes', scr: 'SCR-10', route: '/catalog/comment-codes', perm: 'catalog.test.read', must: [
    [':CODE shortcut copy', /:CODE followed by a space/], ['old results unchanged', /does not change results already saved/], ['code regex', /\^\[A-Z0-9_\]\{1,16\}\$/], ['text max 2000', /2000/] ] },
  { slug: 'doctors', scr: 'SCR-11', route: '/catalog/doctors', perm: 'catalog.referrer.read', must: [
    ['verify queue route', /\/catalog\/doctors\/verify/], ['merge copy', /Past orders keep the original doctor/], ['contact fields need manage permission', /catalog\.referrer\.manage/],
    ['phone E.164', /E\.164|\+977/], ['no names in URLs', /not (in|put in|sent in) (the )?URL|no names in URLs|never in (the )?URL/i], ['verified badge text', /Unverified/] ] },
  { slug: 'credit_parties', scr: 'SCR-12', route: '/catalog/credit-parties', perm: 'catalog.price_list.read', must: [
    ['billing owns limits', /Credit limits, credit days and monthly statements are managed in Billing\./], ['contact fields need manage permission', /catalog\.price_list\.manage/],
    ['credit allowed help', /Off = affiliation with its own prices; patients still pay at the counter/], ['party kinds', /Partner lab/], ['phone E.164', /E\.164|\+977/] ] },
  { slug: 'price_lists', scr: 'SCR-13', route: '/catalog/price-lists', perm: 'catalog.price_list.read', must: [
    ['fall-through help', /When an item is missing here, use the next price list \(doctor → centre → default\)/], ['assignments max 500', /500/], ['centres need identity.centre.read', /identity\.centre\.read/],
    ['versions', /Versions/], ['export/import/compare', /Compare versions/], ['two-step for publish/export', /Requires two-step verification/] ] },
  { slug: 'price_list', scr: 'SCR-13', route: '/catalog/price-lists/', perm: 'catalog.price_list.read', must: [
    ['general/assignments/versions', /Assignments/], ['Applies to create only', /Applies to[^.]*(create only|cannot be changed)|(create only|cannot be changed)[^.]*applies to/i],
    ['Edit prices opens a draft', /Edit prices/], ['Export to Excel', /Export to Excel/], ['Import from Excel', /Import from Excel/] ] },
  { slug: 'price_list_version', scr: 'SCR-14', route: '/catalog/price-lists/', perm: 'catalog.price_list.read', must: [
    ['Ctrl+S saves', /Ctrl\s*\+\s*S/], ['batches of 200', /200/], ['warning above 50 %', /50\s?%/], ['published versions read-only', /read-only/i], ['Create new version', /Create new version/],
    ['publish needs two-step', /Requires two-step verification/], ['no negative prices', /negative/i], ['NPR format', /NPR 1,234\.50/], ['unsaved-changes guard', /unsaved/i] ] },
  { slug: 'price_simulator', scr: 'SCR-15', route: '/catalog/price-simulator', perm: 'catalog.price_list.read', must: [
    ['max 50 orderables', /50/], ['price source order', /Hospital-company/], ['VAT 13 %', /13\s?%/], ['tax disclaimer', new RegExp(DISCLAIMER.replace(/\./g, '\\.'))] ] },
  { slug: 'surcharges', scr: 'SCR-16', route: '/catalog/surcharges', perm: 'catalog.price_list.read', must: [
    ['most specific rule wins', /The most specific rule wins: orderable, then department, then all tests\./], ['applies only when urgent', /Applies only when the order item is marked Urgent\./],
    ['percent range', /0\.01\s*[–-]\s*1000\s?%/], ['End rule', /End rule/] ] },
  { slug: 'tax', scr: 'SCR-17', route: '/catalog/tax', perm: 'catalog.price_list.read', must: [
    ['disclaimer banner', new RegExp(DISCLAIMER.replace(/\./g, '\\.'))], ['no lab default blocks quoting', /Prices cannot be quoted until a lab default tax rule exists\./], ['no pre-selected VAT treatment', /no pre-?selection|nothing is pre-?selected|not pre-?selected/i],
    ['HS code help', /Optional\. Applicability to lab services is not confirmed\./], ['rate history', /rate history/i], ['VAT system row read-only', /VAT[^.]*(system|read-only)/i], ['new rate version keeps earlier rates', /earlier rates/i] ] },
  { slug: 'imports', scr: 'SCR-18/19', route: '/catalog/imports', perm: 'catalog.price_list.manage', must: [
    ['xlsx only 15 MB', /Excel \.xlsx only, up to 15 MB\./], ['macros not accepted', /Macro files \(\.xlsm\) are not accepted\./], ['kinds', /Catalog master/], ['commit dialog change reason', /change reason/i],
    ['Replace open drafts', /Replace open drafts/], ['stale base checkbox', /stale|changed after this file was exported/i], ['file_not_ready banner copy', /Still preparing/], ['polling banner copy', /taking longer than expected/i],
    ['publish needs reference_range.publish', /catalog\.reference_range\.publish/], ['import detail steps', /Security scan/], ['issue copy example', /Price has more than 2 decimal places\./], ['annotated file', /annotated file/i] ] },
];

// ---- helpKeys the UI passes to PageHeader: a new screen without a help page fails here
const compsDir = join(feat, 'components');
const codeKeys = existsSync(compsDir)
  ? [...new Set(readdirSync(compsDir).filter((n) => n.endsWith('.tsx')).flatMap((n) => [...raw(join(compsDir, n)).matchAll(/helpKey="catalog\.([a-z_.-]+)"/g)].map((m) => m[1]!.split('.').pop()!)))]
  : [];
const slugs = [...new Set([...SCREENS.map((s) => s.slug), ...codeKeys])].sort();

describe('C3.T-38 discovery (non-vacuous)', () => {
  it('knows all 19 screens and the helpKeys used by the components', () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(19);
    expect(codeKeys).toEqual(expect.arrayContaining(['home', 'departments', 'price_list_version', 'imports', 'tax', 'comment_codes']));
    expect(slugs.length).toBeGreaterThanOrEqual(19);
  });
});

describe('C3.T-38 in-app help: every catalog screen (04-UI-UX §1, 05-DoD §3.8)', () => {
  it('help folder exists and contains only .md files named after screens', () => {
    expect(existsSync(helpDir), `missing ${helpDir}`).toBe(true);
    for (const n of readdirSync(helpDir)) expect(n, 'help/ holds markdown only').toMatch(/\.md$/);
  });
  it.each(slugs)('help/%s.md exists with title, Purpose, substance', (k) => {
    const p = join(helpDir, `${k}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = raw(p);
    expect(t.length).toBeGreaterThan(600);
    expect(t).toMatch(/^#\s+\S/m); // page title
    expect(t).toMatch(/^##\s+Purpose\s*$/m);
    expect(t, 'English prose, no TODO/TBD/lorem placeholders').not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b/i);
  });
  it.each(SCREENS)('help/$slug.md ($scr) names its permission and route', (s) => {
    const t = helpOf(s.slug);
    expect(t, `${s.slug}: permission ${s.perm}`).toContain(s.perm);
    expect(t, `${s.slug}: route ${s.route}`).toContain(s.route);
  });
  describe.each(SCREENS)('help/$slug.md ($scr) content from 04-UI-UX §4', (s) => {
    it.each(s.must)('covers: %s', (_label, re) => {
      expect(helpOf(s.slug)).toMatch(re);
    });
  });
  it.each(slugs)('help/%s.md never uses the banned word and has no barcode/commission-style copy', (k) => {
    expect(raw(join(helpDir, `${k}.md`)).toLowerCase()).not.toContain(WORD);
  });
  it('tax-bearing help pages (tax, price_simulator) carry the exact tax disclaimer', () => {
    for (const k of ['tax', 'price_simulator']) expect(helpOf(k), k).toContain(DISCLAIMER);
  });
  it('privileged-action pages say "Requires two-step verification" (publish analytes/ranges, publish price lists, imports/exports)', () => {
    for (const k of ['analyte', 'ranges', 'price_list_version', 'price_lists', 'imports']) expect(helpOf(k), k).toContain('Requires two-step verification');
  });
  it('keyboard shortcuts documented once for list screens: / n j k Enter ? Ctrl+S Esc', () => {
    const t = helpOf('departments') + helpOf('tests');
    for (const re of [/`?\/`? (to )?focus/i, /\bn\b[^.]{0,40}new/i, /j\s*\/\s*k|`j`.*`k`/i, /Ctrl\s*\+\s*S/, /Esc/]) expect(t).toMatch(re);
    expect(allManual()).toMatch(/\?[^.]{0,60}shortcut/i);
  });
  it('help pages carry no real-looking patient data or secrets (synthetic only)', () => {
    for (const k of slugs) {
      const t = raw(join(helpDir, `${k}.md`));
      expect(t, `${k}: no email addresses`).not.toMatch(/[A-Za-z0-9._%+-]+@(?!example\.(com|org|net))[A-Za-z0-9.-]+\.[a-z]{2,}/);
      expect(t, `${k}: no tokens`).not.toMatch(/(Bearer\s+[A-Za-z0-9._-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN)/);
    }
  });
});

describe('C3.T-38 user manual docs/manual/catalog: one page per screen (05-DoD §3.8, §1.9)', () => {
  it('README.md exists, links every page, and every link resolves', () => {
    const p = join(manualDir, 'README.md');
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = raw(p);
    expect(t).toMatch(/^#\s+\S/m);
    const links = [...t.matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!);
    for (const l of links) expect(existsSync(resolve(manualDir, l)), `README link ${l} does not resolve`).toBe(true);
    for (const s of SCREENS) expect(links.some((l) => l.endsWith(`${s.slug}.md`)), `README must link ${s.slug}.md`).toBe(true);
    expect(links.some((l) => l.endsWith('integration.md')), 'README must link integration.md').toBe(true);
  });
  it.each(SCREENS)('$slug.md ($scr) exists, names its route and permission, and carries the same key facts as the in-app help', (s) => {
    const p = join(manualDir, `${s.slug}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const raws = raw(p);
    expect(raws.length).toBeGreaterThan(800);
    expect(raws).toMatch(/^#\s+\S/m);
    const t = manualOf(s.slug);
    expect(t).toContain(s.route);
    expect(t).toContain(s.perm);
    expect(t.toLowerCase()).not.toContain(WORD);
    // a manual page repeats the screen's mandatory copy (first 3 checks keep this cheap but real)
    for (const [label, re] of s.must.slice(0, 3)) expect(t, `${s.slug} manual: ${label}`).toMatch(re);
  });
  it('tax pages in the manual carry the exact disclaimer', () => {
    for (const k of ['tax', 'price_simulator']) expect(manualOf(k), k).toContain(DISCLAIMER);
  });
  it('image references resolve to files under docs/manual/catalog/ (synthetic screenshots only)', () => {
    for (const n of mdIn(manualDir)) {
      for (const m of raw(join(manualDir, n)).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^https?:/.test(target)) throw new Error(`${n}: external image ${target} (manual must be self-contained)`);
        expect(existsSync(resolve(manualDir, target)), `${n}: image ${target} missing`).toBe(true);
      }
    }
  });
  it('no page in the manual uses the banned word or leaves placeholders', () => {
    const files = mdIn(manualDir);
    expect(files.length).toBeGreaterThanOrEqual(SCREENS.length + 2);
    for (const n of files) {
      const t = raw(join(manualDir, n));
      expect(t.toLowerCase(), n).not.toContain(WORD);
      expect(t, n).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b/i);
    }
  });
  it('onboarding checklist in the manual: configure a lab-default tax rule before go-live (plan risk R7)', () => {
    const t = allManual();
    expect(t).toMatch(/onboarding/i);
    expect(t).toMatch(/tax[^.]{0,80}(default|rule)[^.]{0,120}(before|first|go-live)|(before|first|go-live)[^.]{0,120}tax[^.]{0,80}(default|rule)/i);
    expect(t).toMatch(/catalog\.tax_config_missing|Tax default configured/);
  });
});

describe('C3.T-38 integration guide docs/manual/catalog/integration.md (04-UI-UX §7)', () => {
  const guide = () => norm(raw(join(manualDir, 'integration.md')));
  it('exists with a title', () => {
    const p = join(manualDir, 'integration.md');
    expect(existsSync(p), `missing ${p}`).toBe(true);
    expect(raw(p)).toMatch(/^#\s+\S/m);
  });
  it.each<[string, RegExp]>([
    ['use CatalogPort from server code', /CatalogPort/],
    ['never the HTTP API from server code', /never[^.]{0,60}HTTP API|not[^.]{0,40}HTTP API/i],
    ['snapshot referenceRangeId + version', /referenceRangeId\s*\+\s*version/],
    ['snapshot priceListId + priceListVersion', /priceListId\s*\+\s*priceListVersion/],
    ['pass birthOn to referenceRangeFor', /birthOn[^.]{0,80}referenceRangeFor|referenceRangeFor[^.]{0,80}birthOn/],
    ['omit ageDays only when age unknown', /ageDays/],
    ['age unknown matches only age-unrestricted bands', /age-unrestricted/],
    ['validate stored price-list id with getPriceListStatus', /getPriceListStatus/],
    ['never read catalog.v_pub_* in a request', /catalog\.v_pub_/],
    ['kind = text is print-only', /kind = text[^.]{0,60}print-only|print-only[^.]{0,60}kind = text/i],
    ['catalog.changed.v1 is cache invalidation only', /catalog\.changed\.v1[^.]{0,80}cache invalidation only/i],
    ['never rebuild state from the event', /never rebuild state from/i],
  ])('covers: %s', (_l, re) => {
    expect(guide()).toMatch(re);
  });
  it('runbook entries: Import stuck / Import quarantined / No price spike (C1 registers the alerts)', () => {
    const t = allManual();
    expect(t).toMatch(/Import stuck/);
    // raw (un-normalised) text: norm() strips `*`, so the verbatim spec name catalog.import_* (04-UI-UX:233) is checked unnormalised (T-38 ruling)
    expect(mdIn(manualDir).map((n) => raw(join(manualDir, n))).join('\n')).toMatch(/catalog\.import_\*/);
    expect(t).toMatch(/dead letters?/i);
    expect(t).toMatch(/re-?enqueue[^.]{0,60}(safe|idempotent)|idempotent[^.]{0,60}re-?enqueue/i);
    expect(t).toMatch(/Import quarantined/);
    expect(t).toMatch(/catalog\.files/);
    expect(t).toMatch(/do not download it on a staff PC/i);
    expect(t).toMatch(/No price spike/);
    expect(t).toMatch(/health report/i);
  });
  it('integration guide is in the manual, not duplicated into in-app help (help is for staff users)', () => {
    expect(existsSync(join(helpDir, 'integration.md'))).toBe(false);
  });
});
