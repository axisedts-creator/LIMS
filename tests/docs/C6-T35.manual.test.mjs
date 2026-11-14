// C6-T35 doc-review tests (plan row: "every screen documented"; IS-23; 04-UI-UX §2 screens, §4 portal, §6 runbooks list).
// ASSUMED naming (dispute if wrong): manual = docs/manual/reporting/README.md (index linking every page) + <slug>.md per staff screen (slug = the help file name
// in apps/web/src/features/reporting/help/, i.e. the suffix of helpKey "reporting.<slug>") + portal.md (patient portal pages, 04-UI-UX §4) + runbooks.md (04-UI-UX §6).
// Each screen page names its route and the permission from contracts/routes.yaml. Screens = fixed SCREENS table UNION help files UNION literal helpKeys in components
// (a new screen without a manual page fails here). Run: node --test tests/docs/C6-T35.manual.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manualDir = join(root, 'docs/manual/reporting');
const helpDir = join(root, 'apps/web/src/features/reporting/help');
const compsDir = join(root, 'apps/web/src/features/reporting/components');
const raw = (p) => readFileSync(p, 'utf8');
const norm = (s) => s.replace(/[`*]/g, '').replace(/ /g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
const mdIn = (d) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);
const page = (slug) => norm(raw(join(manualDir, `${slug}.md`)));
const allManual = () => mdIn(manualDir).map((n) => norm(raw(join(manualDir, n)))).join('\n');

// route + permission copied from contracts/routes.yaml (C6 rows); deliveries/templates lists have no routes.yaml row (T31 note), so only the path is required.
const SCREENS = {
  worklist: { route: '/reporting', perm: 'reporting.report.read', must: [['tabs', /tabs?/i], ['bulk release', /bulk release/i], ['barcode', /barcode/i], ['critical alerts', /critical/i], ['Alt+R', /Alt\+R/]] },
  report: { route: '/reporting/reports/', perm: 'reporting.report.read', must: [['release', /release/i], ['print', /print/i], ['regenerate reason', /regenerat/i], ['Alt+P', /Alt\+P/]] },
  narrative: { route: '/reporting/narratives/', perm: 'reporting.narrative.write', must: [['sign', /sign/i], ['Ctrl+S', /Ctrl\+S/], ['Ctrl+Enter', /Ctrl\+Enter/], ['image', /image/i]] },
  outsourced: { route: '/reporting/outsourced', perm: 'reporting.outsourced.attach', must: [['upload', /upload/i], ['external lab', /external lab/i], ['awaiting file/confirmation', /awaiting (file|confirmation)/i]] },
  deliveries: { route: '/reporting/deliveries', perm: null, must: [['masked destination', /masked/i], ['status filter', /status/i], ['31 days', /31 days/]] },
  delivery: { route: '/reporting/deliveries/', perm: 'reporting.delivery.read', must: [['masked', /masked/i], ['resend', /resend/i], ['never shown', /never shown/i]] },
  templates: { route: '/reporting/templates', perm: null, must: [['template list', /template/i]] },
  template: { route: '/reporting/templates/', perm: 'reporting.template.manage', must: [['template', /template/i], ['version', /version/i]] },
  messages: { route: '/reporting/messages', perm: 'reporting.message_template.manage', must: [['WhatsApp', /WhatsApp/], ['SMS', /SMS/], ['approval in WhatsApp Business account', /WhatsApp Business account/], ['callback URL shown once', /not be shown again|shown once/i], ['secret never entered', /secret itself is never entered/i]] },
  settings: { route: '/reporting/settings', perm: 'reporting.settings.manage', must: [['auto release', /auto[- ]release/i], ['when eligible / manual', /manual/i]] },
};

const helpSlugs = mdIn(helpDir).map((n) => n.replace(/\.md$/, ''));
const tsx = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsx(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : [])) : []);
const keySlugs = tsx(compsDir).flatMap((f) => [...raw(f).matchAll(/helpKey=["'{`]*reporting\.([a-z_]+)/g)].map((m) => m[1])).filter((k) => k !== 'x');
const slugs = [...new Set([...Object.keys(SCREENS), ...helpSlugs, ...keySlugs])].sort();

describe('C6-T35 manual structure', () => {
  test('manual directory has README.md, portal.md, runbooks.md', () => {
    for (const n of ['README.md', 'portal.md', 'runbooks.md']) assert.ok(existsSync(join(manualDir, n)), `missing docs/manual/reporting/${n}`);
  });
  test('screen discovery is non-vacuous and covers the 10 staff screens', () => {
    assert.ok(slugs.length >= 10);
    for (const s of Object.keys(SCREENS)) assert.ok(slugs.includes(s), s);
  });
  test('no orphan manual pages (each is README, portal, runbooks or a screen)', () => {
    const extra = mdIn(manualDir).filter((n) => !['README.md', 'portal.md', 'runbooks.md'].includes(n) && !slugs.includes(n.replace(/\.md$/, '')));
    assert.deepEqual(extra, []);
  });
  test('README links every manual page and every link resolves', () => {
    const t = raw(join(manualDir, 'README.md'));
    for (const n of mdIn(manualDir).filter((x) => x !== 'README.md')) assert.ok(t.includes(n), `README.md must link ${n}`);
    for (const m of t.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      assert.ok(existsSync(resolve(manualDir, m[1])), `README.md broken link ${m[1]}`);
    }
  });
});

describe('C6-T35 every staff screen is documented', () => {
  for (const s of slugs) {
    const def = SCREENS[s];
    test(`${s}.md exists with title, Purpose, Fields, task section, route and permission`, () => {
      const p = join(manualDir, `${s}.md`);
      assert.ok(existsSync(p), `missing ${p}`);
      const r = raw(p);
      const t = norm(r);
      assert.ok(t.length > 500, `${s}.md too short (${t.length})`);
      assert.match(r, /^#\s+\S/m);
      assert.match(r, /^#{2,3}\s+.*Purpose/im, 'needs a Purpose heading');
      assert.match(r, /^#{2,3}\s+.*Fields/im, 'needs a Fields heading');
      assert.match(r, /^#{2,3}\s+.*(Steps|How to|Tasks|Common)/im, 'needs a task heading (Steps / How to / Tasks / Common)');
      if (def) {
        assert.ok(t.includes(def.route), `${s}.md must name route ${def.route}`);
        if (def.perm) assert.ok(t.includes(def.perm), `${s}.md must name permission ${def.perm}`);
        for (const [label, re] of def.must) assert.match(t, re, `${s}.md: ${label}`);
      }
    });
  }
  test('worklist + report manual lists the registered shortcuts (04-UI-UX 1.1)', () => {
    const t = page('worklist') + page('report');
    for (const k of ['Alt+1', 'Alt+6', 'Alt+R', 'Alt+P', 'Alt+D']) assert.ok(t.includes(k), k);
  });
  test('delivery manual covers the failure reasons in plain words', () => {
    const t = page('delivery') + page('deliveries');
    assert.match(t, /consent|agreed/i);
    assert.match(t, /no phone number or email/i);
  });
});

describe('C6-T35 portal page (04-UI-UX 4)', () => {
  test('documents link, OTP, report, QR verification and invalid-link states', () => {
    const t = page('portal');
    for (const [l, re] of [['6-digit code', /6-digit/], ['10 minutes', /10 minutes/], ['Send me a code', /Send me a code/], ['QR verification', /QR/], ['invalid/expired link', /not valid|expired/i],
      ['report status words', /Final.*Amended|Amended.*Final/s], ['rate limit', /Too many attempts/], ['dues', /Payment due|Amount due/i]]) assert.match(t, re, `portal.md: ${l}`);
    assert.match(raw(join(manualDir, 'portal.md')), /^#\s+\S/m);
  });
  // Review C6-T35: C6-T42 payment pages (04-UI-UX 4) must be documented ("every screen documented", IS-23).
  test('documents the payment status and payment return pages (04-UI-UX 4)', () => {
    const t = page('portal');
    for (const s of ['/payments/', '/r/payments/', 'Preparing your payment', 'Continue to eSewa', 'Continue to Khalti', 'We are confirming your payment',
      'Online payment is not available right now', 'Nothing is due on this report', 'A payment for this order is already in progress', 'A payment is in progress',
      'See payment status', 'The exact amount is confirmed when you pay', 'Payment received. Thank you.', 'Back to your report', 'Checking your payment',
      'We have not received confirmation yet', 'The payment was not completed', 'Open your report link again to see your payment status']) assert.ok(t.includes(s), `portal.md: ${s}`);
    assert.match(t, /(never|not)[^.]*(shown|trusted)[^.]*(outcome|gateway)|(outcome|gateway)[^.]*(never|not)[^.]*(shown|trusted)/i, 'portal.md: gateway outcome never shown/trusted');
  });
});

describe('C6-T35 runbooks (04-UI-UX 6)', () => {
  const R = [
    ['renderer stuck / out of memory', /renderer/i, /(restart|sweep)/i],
    ['sandbox rejections spike', /sandbox/i, /(corpus|scanner)/i],
    ['provider outage', /(provider|circuit)/i, /(SMS|fallback|resend)/i],
    ['WhatsApp template rejected', /WhatsApp/i, /(reject|Meta)/i],
    ['rotate a callback token', /callback/i, /rotate/i],
    ['revoke links after a mis-send', /revoke/i, /(mis-?send|batch)/i],
    ['restore a missing PDF', /restore/i, /(backup|immutable)/i],
  ];
  test('runbooks.md has one section per spec scenario with a cause and an action', () => {
    const r = raw(join(manualDir, 'runbooks.md'));
    const t = norm(r);
    assert.ok((r.match(/^##\s+\S/gm) ?? []).length >= R.length, 'one ## section per scenario');
    for (const [label, a, b] of R) { assert.match(t, a, `runbooks.md: ${label}`); assert.match(t, b, `runbooks.md: ${label} (action)`); }
  });
  test('restore runbook says re-render is NOT allowed for released versions', () => {
    assert.match(norm(raw(join(manualDir, 'runbooks.md'))), /(re-?render[^.]*(not allowed|never|must not|cannot)|(not allowed|never|must not|cannot)[^.]*re-?render)/i);
  });
  test('log-search guidance: by report_id / delivery_id / request_id, never by phone or name', () => {
    const t = norm(raw(join(manualDir, 'runbooks.md')));
    for (const k of ['report_id', 'delivery_id', 'request_id']) assert.ok(t.includes(k), k);
    assert.match(t, /never[^.]*(phone|name)/i);
  });
  test('callback-token rotation names the permission verbatim (02-TRD token table)', () => {
    assert.ok(norm(raw(join(manualDir, 'runbooks.md'))).includes('reporting.channel.manage'));
  });
  test('renderer health endpoint is documented verbatim', () => {
    assert.ok(norm(raw(join(manualDir, 'runbooks.md'))).includes('/internal/health'));
  });
});

describe('C6-T35 content hygiene', () => {
  test('synthetic only: no phone numbers, no real-looking emails, no secrets, no real-looking tokens', () => {
    const t = allManual();
    assert.ok(t.length > 3000, 'manual must not be empty');
    assert.doesNotMatch(t, /\+?977[- ]?\d{8,10}|\b9[78]\d{8}\b/);
    assert.doesNotMatch(t, /[\w.+-]+@(?!example\.(com|org)\b)[\w-]+\.\w+/);
    assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_(live|test)_|\bBearer\s+[A-Za-z0-9._-]{20,}/);
    assert.doesNotMatch(t, /\/r\/[A-Za-z0-9_-]{22,}/);
  });
  test('no unfinished-text markers', () => {
    assert.doesNotMatch(allManual(), /\b(TODO|TBD|FIXME|lorem ipsum|XXX)\b/i);
  });
  test('no invented provider endpoints or URLs (provider APIs are UNVERIFIED)', () => {
    const urls = [...allManual().matchAll(/https?:\/\/[^\s)>"']+/g)].map((m) => m[0]);
    assert.deepEqual(urls.filter((u) => !/^https?:\/\/(localhost|[\w.-]*example\.(com|org))\b/.test(u)), []);
  });
  test('manual never tells staff to type a secret value into the form', () => {
    assert.doesNotMatch(allManual(), /enter the (api )?(secret|token|key) (value )?(here|in the form)/i);
  });
});
