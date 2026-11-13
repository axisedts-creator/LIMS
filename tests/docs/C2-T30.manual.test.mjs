// C2-T30 doc lint (plan row T30: "page per screen", tests "doc lint", AC S24 "User manual pages + in-app help for every C2 screen").
// Run: node --test tests/docs/C2-T30.manual.test.mjs   (modelled on tests/docs/C6-T35.manual.test.mjs)
// ASSUMED naming (dispute if wrong):
//  - manual: docs/manual/admin/<slug>.md and docs/manual/platform/<slug>.md, one per page.tsx under app/(staff)/admin and app/(platform)/platform,
//    plus README.md (index linking every page) in each folder, plus docs/manual/admin/sign-in.md for the pre-login screens AU-1..AU-7.
//  - in-app help: apps/web/src/features/{admin,platform}/help/<slug>.md (same slugs; admin already has 16 from T20; platform has none).
//  - slug = the T20 help names for admin; platform: home, tenants, tenant-new, tenant-detail, ird, support-sessions, dead-letters, dead-letter-detail, staff, auth-events.
//  - pre-login screens have no HelpPanel (04-UI-UX §4: footer help link), so sign-in has a manual page but no in-app help file.
// Each manual page names its route (and the permission) as written in contracts/routes.yaml, which is read here, not copied.
// LD-140 (2026-11-13): admin/platform screens are in the new look (masters = list + right drawer + per-section Save; roles = PermissionMatrix with an MFA badge on
//   roles holding privileged permissions). Applying a role pack is RM-T05, so the manual must not describe it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const raw = (p) => readFileSync(p, 'utf8');
const norm = (s) => s.replace(/[`*_]/g, '').replace(/ /g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
const mdIn = (d) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);

// ---- routes.yaml (route id -> { path, permission })
const routes = {};
for (const line of raw(join(root, 'contracts/routes.yaml')).split(/\r?\n/)) {
  const id = line.match(/\bid:\s*([\w.]+)\s*,/)?.[1];
  const path = line.match(/\bpath:\s*"?([^",\s]+)"?\s*,/)?.[1];
  if (id && path) routes[id] = { path, perm: line.match(/\bpermission:\s*([\w.]+)/)?.[1] ?? null };
}

const AREAS = {
  admin: { manual: join(root, 'docs/manual/admin'), help: join(root, 'apps/web/src/features/admin/help'), app: join(root, 'apps/web/src/app/(staff)/admin') },
  platform: { manual: join(root, 'docs/manual/platform'), help: join(root, 'apps/web/src/features/platform/help'), app: join(root, 'apps/web/src/app/(platform)/platform') },
};

// slug: { area, page (page.tsx, or array of them, relative to the area app dir; roles/new shares the role-editor page), rid (routes.yaml id) | path (literal when no yaml row), must: [[label, regex]] }
const S = (area, page, rid, path, must) => ({ area, page, rid, path, must });
const SCREENS = {
  // ---- tenant admin (04-UI-UX §5, §6)
  me: S('admin', 'me/page.tsx', 'staff.admin.me', null, [['tabs Profile/Security/Sessions', /profile.*security.*sessions/i], ['change password', /change password/i], ['two-step verification', /two-step verification/i], ['log out this session', /log out this session/i]]),
  users: S('admin', 'users/page.tsx', 'staff.admin.users', null, [['filters', /status.*locked.*role.*centre.*(mfa|two-step)/i], ['masked email', /masked/i], ['Invite user', /invite user/i], ['search', /search/i]]),
  'user-new': S('admin', 'users/new/page.tsx', 'staff.admin.user_new', null, [['Email', /email/i], ['Full name', /full name/i], ['Mobile', /mobile/i], ['Roles', /roles/i], ['All centres / Selected centres', /all centres.*selected centres/i], ['MFA required tag', /(mfa|two-step verification) required/i], ['Send invitation', /send invitation/i]]),
  'user-detail': S('admin', 'users/[membership_id]/page.tsx', 'staff.admin.user', null, [['Lock', /lock/i], ['Deactivate', /deactivate/i], ['Reset two-step verification', /reset two-step verification/i], ['Log out all sessions', /log out all sessions/i], ['Signatory tab', /signatory/i], ['saving logs the user out', /logs? (this user|the user|them) out/i]]),
  roles: S('admin', 'roles/page.tsx', 'staff.admin.roles', null, [['New role', /new role/i], ['default roles', /default/i], ['MFA badge (LD-140)', /(mfa|two-step verification)[^.]*badge|badge[^.]*(mfa|two-step verification)/i], ['members', /members/i]]),
  'role-editor': S('admin', ['roles/[role_id]/page.tsx', 'roles/new/page.tsx'], null, '/admin/roles/', [['Code', /code/i], ['Permissions matrix', /permission/i], ['MFA required switch (LD-140 badge/forced on)', /(mfa|two-step verification) required/i], ['logs out everyone', /logs? out everyone/i], ['Deactivate role', /deactivate/i]]),
  branches: S('admin', 'branches/page.tsx', 'staff.admin.branches', null, [['right drawer (LD-140)', /drawer/i], ['per-section Save (LD-140)', /\bsave\b/i], ['Code cannot change', /(cannot|can't|not) be changed|immutable|read-only/i], ['Processing lab', /processing lab/i]]),
  centres: S('admin', 'centres/page.tsx', 'staff.admin.centres', null, [['right drawer (LD-140)', /drawer/i], ['per-section Save (LD-140)', /\bsave\b/i], ['types Own/Franchise/Home collection', /own.*franchise.*home collection/i], ['Branch', /branch/i]]),
  settings: S('admin', 'settings/page.tsx', 'staff.admin.settings', null, [['tabs', /general.*date (&|and) time.*sign-in (&|and) sessions.*numbering.*letterhead (&|and) branding.*reports (&|and) delivery.*data retention.*features.*billing (&|and) ird.*lab operations/i], ['per-tab Save (LD-140)', /each tab.*\bsave\b|\bsave\b.*each tab|saved separately/i], ['changed by someone else -> Reload', /someone else/i], ['Asia/Kathmandu', /Asia\/Kathmandu/], ['takes effect from FY', /takes effect from FY/i]]),
  sessions: S('admin', 'sessions/page.tsx', 'staff.admin.sessions', null, [['Log out', /log out/i], ['Support badge', /support/i], ['two-step verified', /two-step|verified/i], ['masked IP', /ip/i]]),
  audit: S('admin', 'audit/page.tsx', 'staff.admin.audit', null, [['date range 31 days', /31 days/i], ['Table / Action / User filters', /table.*action.*user/i], ['Export', /export/i], ['changed fields', /changed fields/i]]),
  'audit-entry': S('admin', 'audit/[audit_id]/page.tsx', 'staff.admin.audit_entry', null, [['request id', /request id/i], ['changed fields / differences', /(changed fields|differences|diff)/i], ['your viewing is recorded', /your viewing .*recorded|viewing .*recorded/i]]),
  'access-log': S('admin', 'access-log/page.tsx', 'staff.admin.access_log', null, [['Access log tab', /access log/i], ['Sign-in events tab', /sign-in events/i], ['Entity', /entity/i]]),
  exports: S('admin', 'exports/page.tsx', 'staff.admin.exports', null, [['New export', /new export/i], ['CSV only', /csv/i], ['31 days', /31 days/i], ['administrators notified', /notified/i], ['all centres needed', /all centres/i], ['no changed values', /(do not|don't|never) include changed values|without changed values|changed values are not included/i]]),
  'support-access': S('admin', 'support-access/page.tsx', 'staff.admin.support_access', null, [['Approve', /approve/i], ['Deny', /deny/i], ['End access', /end access/i], ['History', /history/i]]),
  'access-review': S('admin', 'access-review/page.tsx', 'staff.admin.access_review', null, [['Record review completed', /record review completed/i], ['90 days', /90 days/i], ['Notes', /notes/i]]),
  // ---- platform console (04-UI-UX §7)
  home: S('platform', 'page.tsx', 'staff.platform.home', null, [['tenants by status', /tenants by status/i], ['open dead letters', /open dead letters/i], ['active support sessions', /active support sessions/i], ['incomplete IRD annexes', /ird annex/i]]),
  tenants: S('platform', 'tenants/page.tsx', 'staff.platform.tenants', null, [['columns', /code.*display name.*status.*users.*centres.*ird readiness.*created/i], ['Provision tenant', /provision tenant/i], ['IRD readiness Complete/Incomplete', /complete.*incomplete|incomplete.*complete/i]]),
  'tenant-new': S('platform', 'tenants/new/page.tsx', null, '/platform/tenants/new', [['sections: tenant, first branch, first centre, first administrator', /first branch.*first centre.*first administrator/i], ['tenant code rule', /tenant code/i], ['timezone Asia/Kathmandu read-only', /Asia\/Kathmandu/], ['Invitation sent', /invitation/i], ['checklist of created items', /checklist/i]]),
  'tenant-detail': S('platform', 'tenants/[tenant_id]/page.tsx', 'staff.platform.tenant', null, [['tabs', /overview.*settings.*feature flags.*ird annexes.*administrators.*support sessions/i], ['Activate/Suspend/Reactivate/Terminate', /activate.*suspend.*reactivate.*terminate/i], ['terminate needs the tenant code typed', /type the tenant code|typing the tenant code|typed? .*tenant code/i], ['reason required for destructive actions', /reason/i]]),
  ird: S('platform', 'ird/page.tsx', 'staff.platform.ird', null, [['Annex 1/2/3/7', /annex 1.*annex 2.*annex 3.*annex 7/i], ['Tracking only banner (B6)', /tracking only/i], ['Scan pending', /scan pending/i], ['15 MB upload limit', /15 MB/i], ['Superseded successor', /superseded/i]]),
  'support-sessions': S('platform', 'support-sessions/page.tsx', 'staff.platform.support_sessions', null, [['Open support session', /open support session/i], ['scope Read only / Admin', /read only.*admin/i], ['no patient details in the reason', /no patient details/i], ['ticket reference', /ticket reference/i], ['duration 5-60 minutes', /5\s*(-|–|to)\s*60/i], ['End', /\bend\b/i]]),
  'dead-letters': S('platform', 'dead-letters/page.tsx', 'staff.platform.dead_letters', null, [['State filter default Open', /state.*open/i], ['Platform tasks only', /platform tasks only/i], ['columns', /dead at.*tenant.*task.*attempts.*last error code.*state/i]]),
  'dead-letter-detail': S('platform', 'dead-letters/[dead_letter_id]/page.tsx', 'staff.platform.dead_letter', null, [['Replay', /replay/i], ['Discard', /discard/i], ['reason 1-500', /500/], ['job payload never shown', /(no|never|not).{0,40}(job )?payload|payload.{0,40}(never|not) (shown|displayed)/i], ['changed by someone else', /someone else/i]]),
  staff: S('platform', 'staff/page.tsx', 'staff.platform.staff', null, [['columns', /name.*email.*role.*allowed networks.*mfa.*status/i], ['CIDR', /cidr/i], ['invite', /invite/i], ['Log out sessions', /log out/i]]),
  'auth-events': S('platform', 'auth-events/page.tsx', 'staff.platform.auth_events', null, [['31 days', /31 days/i], ['No tenant', /no tenant/i], ['columns', /time.*tenant.*user.*event.*reason.*ip.*browser/i]]),
};

// pre-login screens (04-UI-UX §4): one manual page, no in-app help panel
const SIGN_IN = { slug: 'sign-in', route: '/auth/login', must: [['AU-1 Log in', /log in/i], ['Forgot password', /forgot password/i], ['MFA challenge 6-digit code', /6-digit code/i], ['MFA enrolment', /authenticator app/i], ['reset link 60 minutes', /60 minutes/i], ['password length 12', /12 characters/i], ['session expired / logged out', /(logged out|session expired)/i], ['locked account', /locked/i]] };

const slugsOf = (area) => Object.keys(SCREENS).filter((k) => SCREENS[k].area === area);
const pageFiles = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pageFiles(join(d, e.name)) : e.name === 'page.tsx' ? [join(d, e.name)] : [])) : []);
const rel = (base, f) => f.slice(base.length + 1).replace(/\\/g, '/');
const routeOf = (s) => (s.rid ? routes[s.rid]?.path : s.path);

describe('C2-T30 setup is not vacuous', () => {
  test('routes.yaml has every C2 staff route this test cites', () => {
    for (const [slug, s] of Object.entries(SCREENS)) if (s.rid) assert.ok(routes[s.rid], `${slug}: ${s.rid} missing from contracts/routes.yaml`);
    assert.ok(Object.keys(SCREENS).length >= 26);
  });
  test('every page.tsx under the admin and platform app folders is in the screen table (a new screen needs a manual page)', () => {
    for (const [area, d] of Object.entries(AREAS)) {
      const known = new Set(slugsOf(area).flatMap((k) => [SCREENS[k].page].flat()));
      const found = pageFiles(d.app).map((f) => rel(d.app, f));
      assert.ok(found.length >= (area === 'admin' ? 15 : 9), `${area}: found only ${found.length} page.tsx`);
      assert.deepEqual(found.filter((f) => !known.has(f)).sort(), [], `${area}: pages without a SCREENS entry (add a manual page + help file)`);
    }
  });
});

for (const [area, d] of Object.entries(AREAS)) {
  describe(`C2-T30 manual structure (docs/manual/${area})`, () => {
    const slugs = slugsOf(area);
    const expected = area === 'admin' ? [...slugs, SIGN_IN.slug] : slugs;
    test('README.md exists, has one H1, and links every page; links resolve', () => {
      const p = join(d.manual, 'README.md');
      assert.ok(existsSync(p), `missing docs/manual/${area}/README.md`);
      const t = raw(p);
      assert.match(t, /^#\s+\S/m);
      for (const s of expected) assert.ok(t.includes(`${s}.md`), `README.md must link ${s}.md`);
      for (const m of t.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        assert.ok(existsSync(resolve(d.manual, m[1])), `README.md broken link ${m[1]}`);
      }
    });
    test('no orphan pages: every .md is README or a known screen', () => {
      assert.deepEqual(mdIn(d.manual).filter((n) => n !== 'README.md' && !expected.includes(n.replace(/\.md$/, ''))), []);
    });
  });
}

describe('C2-T30 every screen has a manual page (S24)', () => {
  for (const [slug, s] of Object.entries(SCREENS)) {
    const file = join(AREAS[s.area].manual, `${slug}.md`);
    test(`${s.area}/${slug}.md: structure, route, permission, content`, () => {
      assert.ok(existsSync(file), `missing ${file}`);
      const r = raw(file);
      const t = norm(r);
      assert.ok(t.length > 500, `${slug}.md too short (${t.length} chars)`);
      assert.equal((r.match(/^#\s+\S/gm) || []).length, 1, 'exactly one H1');
      assert.match(r, /^#{2,3}\s+.*Purpose/im, 'needs a Purpose heading');
      assert.match(r, /^#{2,3}\s+.*(Fields|Columns|Filters|Tabs|Sections)/im, 'needs a Fields / Columns / Filters / Tabs heading');
      assert.match(r, /^#{2,3}\s+.*(Steps|How to|Tasks|Common)/im, 'needs a task heading (Steps / How to / Tasks / Common)');
      const path = routeOf(s);
      assert.ok(path, `${slug}: no route known`);
      assert.ok(t.includes(norm(path)), `${slug}.md must name route ${path}`);
      const perm = s.rid ? routes[s.rid].perm : null;
      if (perm) assert.ok(t.includes(norm(perm)), `${slug}.md must name permission ${perm}`);
      for (const [label, re] of s.must) assert.match(t, re, `${slug}.md: ${label}`);
    });
  }
  test('admin/sign-in.md covers the pre-login screens AU-1..AU-7', () => {
    const file = join(AREAS.admin.manual, 'sign-in.md');
    assert.ok(existsSync(file), `missing ${file}`);
    const r = raw(file);
    const t = norm(r);
    assert.ok(t.length > 700, `sign-in.md too short (${t.length} chars)`);
    assert.match(r, /^#\s+\S/m);
    assert.match(r, /^#{2,3}\s+.*Purpose/im);
    assert.match(r, /^#{2,3}\s+.*(Steps|How to|Tasks|Common)/im);
    assert.ok(t.includes(SIGN_IN.route), `sign-in.md must name ${SIGN_IN.route}`);
    for (const [label, re] of SIGN_IN.must) assert.match(t, re, `sign-in.md: ${label}`);
  });
});

describe('C2-T30 in-app help exists for every screen (04-UI-UX §3 "Help": features/<m>/help/<screen>.md)', () => {
  for (const [slug, s] of Object.entries(SCREENS)) {
    test(`features/${s.area}/help/${slug}.md: exists, one H1, short, non-trivial`, () => {
      const f = join(AREAS[s.area].help, `${slug}.md`);
      assert.ok(existsSync(f), `missing ${f}`);
      const r = raw(f);
      assert.match(r, /^#\s+\S/, 'starts with an H1');
      assert.ok(r.trim().length > 80, 'too short');
      assert.ok(r.length < 2500, 'in-app help must stay short; put detail in the manual');
    });
  }
  test('no orphan help files', () => {
    for (const [area, d] of Object.entries(AREAS)) {
      const slugs = slugsOf(area);
      assert.deepEqual(mdIn(d.help).filter((n) => !slugs.includes(n.replace(/\.md$/, ''))), [], `${area} help orphans`);
    }
  });
});

describe('C2-T30 doc lint (all manual pages and help files)', () => {
  const files = () => [
    ...Object.values(AREAS).flatMap((d) => [...mdIn(d.manual).map((n) => join(d.manual, n)), ...mdIn(d.help).map((n) => join(d.help, n))]),
  ];
  test('lint covers real files', () => assert.ok(files().length >= 30, `only ${files().length} md files found`));
  test('no placeholders (TODO, TBD, FIXME, lorem, XXX, "coming soon")', () => {
    for (const f of files()) assert.doesNotMatch(raw(f), /\b(TODO|TBD|FIXME|XXX)\b|lorem ipsum|coming soon/i, f);
  });
  test('code fences are balanced, no raw script/iframe HTML, no heading level jumps', () => {
    for (const f of files()) {
      const r = raw(f);
      assert.equal((r.match(/^```/gm) || []).length % 2, 0, `${f}: unbalanced code fence`);
      assert.doesNotMatch(r, /<\s*(script|iframe|object|embed)\b/i, f);
      let prev = 0;
      for (const m of r.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^(#{1,6})\s/gm)) {
        assert.ok(m[1].length <= prev + 1, `${f}: heading level jumps from H${prev} to H${m[1].length}`);
        prev = m[1].length;
      }
    }
  });
  test('synthetic data only: every email is on example.test/.com/.org, no secrets or tokens (CLAUDE.md, 07-SECURITY)', () => {
    for (const f of files()) {
      const r = raw(f);
      for (const m of r.matchAll(/[A-Za-z0-9._%+*-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) assert.match(m[1], /^example\.(test|com|org)$/i, `${f}: real-looking email ${m[0]}`);
      assert.doesNotMatch(r, /eyJ[A-Za-z0-9_-]{10,}\.|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*KEY|(password|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}|\bsk_(live|test)_|\bpostgres(ql)?:\/\//i, `${f}: secret-looking text`);
    }
  });
  test('relative links resolve (to files in the manual or the repo)', () => {
    for (const f of files()) {
      for (const m of raw(f).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^([a-z]+:|\/)/i.test(m[1])) continue;
        assert.ok(existsSync(resolve(dirname(f), m[1])), `${f}: broken link ${m[1]}`);
      }
    }
  });
  test('LD-140: the manual does not describe applying a role pack (task RM-T05)', () => {
    for (const f of mdIn(AREAS.admin.manual).map((n) => join(AREAS.admin.manual, n))) assert.doesNotMatch(raw(f), /role pack/i, f);
  });
  test('no screen text leaks internals: no raw error codes as the only guidance, no table or column names of the database', () => {
    for (const f of files()) assert.doesNotMatch(raw(f), /\b(core|audit)\.[a-z_]+\s+(table|row)|\bRLS\b|service_role|\bGoTrue\b/i, f);
  });
});
