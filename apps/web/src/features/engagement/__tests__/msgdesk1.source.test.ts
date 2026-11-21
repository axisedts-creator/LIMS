// T0D-MSGDESK-1 static checks (tester-owned; node environment, no rendering). What these pin (done_when 1, 2, 3, 4, 5 and the LD-353 / LD-321 / LD-310 rules):
//   - the first walk is written down (done_when 1): .orchestra/notes/T0D-MSGDESK-1-walk.md names the ElabAssist screens and what is missing;
//   - four new staff routes (templates, broadcasts, ticket inbox, ticket thread) with page files, contracts/routes.yaml rows and nav entries, registered like T0D-ACCT-1 / T0D-SALES-1;
//   - no new library (rich text, table, state, date), BFF only: typed calls in server-only files, POST writes carry an Idempotency-Key, PATCH / close / reopen / deactivate carry If-Match;
//   - client components never fetch, never see the access token, never import *.server for values; text from the message catalogue (engagement.msg.*, partners.ticket.*), no exclamation marks;
//   - blocked controls give a visible reason that names the permission code; only known permission codes appear; nothing under admin / platform / (auth) / (platform) is touched.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const SRC = join(WEB, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? (e === '__tests__' || e === 'node_modules' ? [] : walk(p)) : [p]; }) : []);
const rel = (p: string) => relative(WEB, p).split('\\').join('/');
const code = (f: string) => /\.(ts|tsx)$/.test(f);
const FEATURE_FILES = [...walk(join(SRC, 'features', 'engagement')), ...walk(join(SRC, 'features', 'partners'))].filter(code);
const PAGE = (...seg: string[]) => join(SRC, 'app', '(staff)', ...seg, 'page.tsx');
const PAGES = [PAGE('engagement', 'messages', 'templates'), PAGE('engagement', 'messages', 'broadcasts'), PAGE('partners', 'tickets'), PAGE('partners', 'tickets', '[ticket_id]')];

/** Server side files: carry one of the operation paths of this task. */
const SERVER_MARK = /broadcast-templates|\/broadcasts|broadcast-audience-previews|admin\/tickets/;
const msgServer = FEATURE_FILES.filter((f) => /server|actions/.test(rel(f))).filter((f) => SERVER_MARK.test(read(f)));
/** Client components of the message screens: tsx files that use this task's catalogue keys. */
const msgClient = FEATURE_FILES.filter((f) => f.endsWith('.tsx') && /\b(engagement\.msg\.|partners\.ticket\.)/.test(read(f)));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const keysOf = (re: RegExp) => [...messagesSrc.matchAll(new RegExp(`'(${re.source}[a-z0-9_.]*)':\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`, 'g'))].map((m) => ({ key: m[1]!, text: m[2] ?? m[3]! }));
const msgKeys = keysOf(/engagement\.msg\./);
const ticketKeys = keysOf(/partners\.ticket\./);
const text = (k: string) => [...msgKeys, ...ticketKeys].find((x) => x.key === k)?.text;

describe('T0D-MSGDESK-1 first walk (done_when 1)', () => {
  it('.orchestra/notes/T0D-MSGDESK-1-walk.md says which ElabAssist screen each LIMS screen replaces and what is missing', () => {
    const f = join(ROOT, '.orchestra', 'notes', 'T0D-MSGDESK-1-walk.md');
    expect(existsSync(f), 'the writer writes the walk note first').toBe(true);
    const t = read(f);
    for (const w of [/Messages/i, /Message To Lab/i, /Create New Template/i, /Log page/i, /Status/i, /Replied/i, /replaces/i, /missing/i]) expect(t, String(w)).toMatch(w);
    expect(t.length).toBeGreaterThan(500);
  });
});

describe('T0D-MSGDESK-1 routes and navigation (registered like T0D-ACCT-1)', () => {
  const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner: string; permission?: string }[] }).routes;
  const WANT: [string, string, string][] = [
    ['/engagement/messages/templates', 'engagement.broadcast.read', 'staff.engagement.'],
    ['/engagement/messages/broadcasts', 'engagement.broadcast.read', 'staff.engagement.'],
    ['/partners/tickets', 'partners.ticket.read', 'staff.partners.'],
    ['/partners/tickets/{ticket_id}', 'partners.ticket.read', 'staff.partners.'],
  ];
  it.each(WANT.map((w, i) => [...w, i] as [string, string, string, number]))('%s has a page file and a routes.yaml row (staff_web, %s)', (p, perm, idPrefix, i) => {
    expect(existsSync(PAGES[i]!), `page.tsx for ${p}`).toBe(true);
    const r = routes.find((x) => x.path === p);
    expect(r, `routes.yaml row for ${p}`).toBeTruthy();
    expect(r!.origin).toBe('staff_web');
    expect(r!.permission).toBe(perm);
    expect(r!.id.startsWith(idPrefix), r!.id).toBe(true);
    expect(r!.id).toMatch(/^staff\.[a-z]+\.[a-z_]+$/);
  });
  it('the four route ids are unique and no admin or platform route was added or renamed for this task', () => {
    const ids = WANT.map(([p]) => routes.find((x) => x.path === p)?.id);
    expect(new Set(ids).size).toBe(4);
    expect(routes.filter((r) => /(messages|tickets|broadcast)/i.test(r.path) && /^\/(admin|platform)/.test(r.path))).toEqual([]);
  });
  const entryLine = (manifest: string, routeId: string) => manifest.split('\n').find((l) => l.includes(`routeId: '${routeId}'`));
  it('the engagement nav manifest gains two entries after the ten existing ones (templates, broadcasts): permission engagement.broadcast.read, group engagement, order > 100, label = a catalogue key', () => {
    const m = read(join(SRC, 'features', 'engagement', 'nav.manifest.ts'));
    for (const p of ['/engagement/messages/templates', '/engagement/messages/broadcasts']) {
      const routeId = routes.find((x) => x.path === p)?.id;
      const line = entryLine(m, routeId ?? 'none');
      expect(line, `nav entry for ${p}`).toBeTruthy();
      expect(line).toMatch(/permission: 'engagement\.broadcast\.read'/);
      expect(line).toMatch(/group: 'engagement'/);
      expect(Number(/order: (\d+)/.exec(line!)?.[1])).toBeGreaterThan(100);
      const label = /label: '([^']+)'/.exec(line!)?.[1] ?? '';
      expect(messagesSrc, `label key ${label}`).toContain(`'${label}'`);
    }
    const orders = [...m.matchAll(/order: (\d+)/g)].map((x) => Number(x[1]));
    expect(new Set(orders).size, 'orders are unique').toBe(orders.length);
    for (const id of ['engagement.queue', 'engagement.bookings', 'engagement.reminders', 'engagement.enquiries', 'engagement.memberships', 'engagement.slots', 'engagement.bookable', 'engagement.queue_setup', 'engagement.settings', 'engagement.content']) expect(m).toContain(`id: '${id}'`);
  });
  it('the partners nav manifest gains the ticket inbox entry after the twelve existing ones: permission partners.ticket.read, group partners, order > 120, label = a catalogue key', () => {
    const m = read(join(SRC, 'features', 'partners', 'nav.manifest.ts'));
    const routeId = routes.find((x) => x.path === '/partners/tickets')?.id;
    const line = entryLine(m, routeId ?? 'none');
    expect(line, 'nav entry for /partners/tickets').toBeTruthy();
    expect(line).toMatch(/permission: 'partners\.ticket\.read'/);
    expect(line).toMatch(/group: 'partners'/);
    expect(Number(/order: (\d+)/.exec(line!)?.[1])).toBeGreaterThan(120);
    const label = /label: '([^']+)'/.exec(line!)?.[1] ?? '';
    expect(messagesSrc, `label key ${label}`).toContain(`'${label}'`);
    const orders = [...m.matchAll(/order: (\d+)/g)].map((x) => Number(x[1]));
    expect(new Set(orders).size, 'orders are unique').toBe(orders.length);
    for (const id of ['partners.inbox', 'partners.pickups', 'partners.list', 'partners.referrers', 'partners.settings', 'partners.sales_designations', 'partners.onboarding', 'partners.penalties', 'partners.penalty_events']) expect(m).toContain(`id: '${id}'`);
  });
  it('menu names: the templates label says template, the broadcasts label says message or broadcast, the inbox label says ticket or message (ElabAssist: Messages, Message To Laboratory)', () => {
    const label = (p: string, manifest: string) => /label: '([^']+)'/.exec(entryLine(read(join(SRC, 'features', manifest, 'nav.manifest.ts')), routes.find((x) => x.path === p)?.id ?? 'none') ?? '')?.[1] ?? '';
    const val = (k: string) => new RegExp(`'${k.replace(/\./g, '\\.')}':\\s*'([^']*)'`).exec(messagesSrc)?.[1] ?? '';
    expect(val(label('/engagement/messages/templates', 'engagement'))).toMatch(/template/i);
    expect(val(label('/engagement/messages/broadcasts', 'engagement'))).toMatch(/message|broadcast/i);
    expect(val(label('/partners/tickets', 'partners'))).toMatch(/ticket|message/i);
  });
  it('no source file of this task is added under features/admin, features/platform, app/(auth), app/(platform)', () => {
    const bad = [...msgServer, ...msgClient].filter((f) => /features\/(admin|platform)\/|app\/\((auth|platform)\)/.test(rel(f)));
    expect(bad.map(rel)).toEqual([]);
  });
});

describe('T0D-MSGDESK-1 no new library, light on low end PCs (done_when 4)', () => {
  const pkg = JSON.parse(read(join(WEB, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const FORBIDDEN = ['react-quill', 'quill', 'draft-js', 'slate', 'slate-react', '@tiptap/react', '@tiptap/core', 'lexical', '@lexical/react', 'react-table', '@tanstack/react-table', 'ag-grid-react', 'react-virtualized', 'react-window', 'react-datepicker', 'moment', 'lodash', 'swr', '@tanstack/react-query', 'react-query', 'zustand', 'redux', 'socket.io-client'];
  it('apps/web/package.json has none of the rich text, grid, virtual list, date, state or push libraries', () => {
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => FORBIDDEN.includes(d))).toEqual([]);
  });
  it('no message source imports one of them', () => {
    const bad = [...msgServer, ...msgClient, ...PAGES.filter(existsSync)].filter((f) => new RegExp(`from ['"](${FORBIDDEN.join('|')})['"/]`).test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it('every list call passes a limit (lists are paged, at most 200 a page)', () => {
    const t = msgServer.map(read).join('\n');
    expect(t).toMatch(/limit/);
    expect(t).not.toMatch(/limit[=:]\s*['"`]?(?:[3-9]\d\d|\d{4,})\b/);
  });
});

describe('T0D-MSGDESK-1 typed calls (BFF)', () => {
  const OPS: [string, RegExp][] = [
    ['listBroadcastTemplates / createBroadcastTemplate / updateBroadcastTemplate', /broadcast-templates/],
    ['deactivateBroadcastTemplate', /broadcast-templates\/\$\{[^}]+\}\/deactivate|\/deactivate/],
    ['listBroadcasts / createBroadcast', /\/broadcasts/],
    ['previewBroadcastAudience', /broadcast-audience-previews/],
    ['requestBroadcastApproval', /request-approval/],
    ['approveBroadcast', /\/approve/],
    ['cancelBroadcast', /\/cancel/],
    ['listBroadcastRecipients', /\/recipients/],
    ['listPartnerTickets / createPartnerTicket / getPartnerTicket', /admin\/tickets/],
    ['replyPartnerTicket', /admin\/tickets\/\$\{[^}]+\}\/messages|\/messages/],
    ['closePartnerTicket', /\/close/],
    ['reopenPartnerTicket', /\/reopen/],
  ];
  it.each(OPS)('%s has a typed call in a server file', (_n, re) => {
    expect(msgServer.some((f) => re.test(read(f))), `no server file calls ${re}`).toBe(true);
  });
  it('every file that carries an operation path is server-only (REQ-SEC-068: the bearer JWT stays on the server) or a "use server" actions file', () => {
    expect(msgServer.length).toBeGreaterThanOrEqual(2);
    for (const f of msgServer) expect(/import 'server-only'|import "server-only"|^'use server'|^"use server"/m.test(read(f)), rel(f)).toBe(true);
  });
  it('POST writes carry an Idempotency-Key, PATCH / close / reopen / deactivate / approve carry If-Match, ids are shape checked before they reach a path', () => {
    const t = msgServer.map(read).join('\n');
    expect(t).toMatch(/idempotency-key/i);
    expect(t).toMatch(/if-match/i);
    expect(t).toMatch(/uuid\(|UUID_RE|isUuid|UUID\.test/i);
  });
  it('the preview call is a POST with a closed audience filter: party_kinds is the only required key; no free query string is built from user input', () => {
    const t = msgServer.map(read).join('\n');
    expect(t).toMatch(/party_kinds/);
    expect(t).not.toMatch(/audience_filter\s*[:=]\s*(?:JSON\.parse|req\.|input\.query)/);
  });
  it('no operation_pending branch is left for these operations (live since T0B-MSGDESK-1)', () => {
    for (const f of [...msgServer, ...msgClient]) expect(/operation_pending/.test(read(f)), rel(f)).toBe(false);
  });
  it('permissions are the known ones; no new code is invented', () => {
    const t = [...msgServer, ...msgClient, ...PAGES.filter(existsSync)].map(read).join('\n');
    const found = new Set([...t.matchAll(/['"`]((?:engagement|partners)\.(?:broadcast|ticket|partner)\.(?:read|manage|approve))['"`]/g)].map((m) => m[1]!));
    for (const c of found) expect(['engagement.broadcast.read', 'engagement.broadcast.manage', 'engagement.broadcast.approve', 'partners.ticket.read', 'partners.ticket.manage', 'partners.partner.read']).toContain(c);
    for (const c of ['engagement.broadcast.manage', 'engagement.broadcast.approve', 'partners.ticket.manage']) expect(found.has(c), c).toBe(true);
  });
  it('the signed-in user id for the second person rule is read from the access token the server already holds (JWT sub); it is not asked from the browser', () => {
    const t = [...msgServer, ...PAGES.filter(existsSync)].map(read).join('\n');
    expect(t).toMatch(/getAccessToken/);
    expect(t).toMatch(/\bsub\b/);
  });
});

describe('T0D-MSGDESK-1 client components', () => {
  it('there are client components for templates, broadcasts and the ticket screens', () => {
    expect(msgClient.length).toBeGreaterThanOrEqual(3);
    expect(msgClient.some((f) => /\{\{party_name\}\}|party_name/.test(read(f))), 'the placeholder helper names the closed list').toBe(true);
    expect(msgClient.some((f) => /Approve/.test(read(f))), 'an Approve control').toBe(true);
  });
  it('no client component calls fetch, XMLHttpRequest or a hard-coded URL directly, and none imports the session / token module', () => {
    for (const f of msgClient) {
      const t = read(f);
      expect(/\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/.test(t), rel(f)).toBe(false);
      expect(/core\/session\/server|getAccessToken|accessToken/.test(t), `${rel(f)} must not touch the token`).toBe(false);
    }
  });
  it('client components import *.server modules for TYPES only', () => {
    for (const f of msgClient) for (const m of read(f).matchAll(/^import\s+(?!type\b)[^;]*from ['"][^'"]*\.server['"]/gm)) throw new Error(`${rel(f)} imports a .server module for values: ${m[0]}`);
  });
  it('the dates use native date inputs (no picker library) and the tables use the compact table class and the empty-row kit parts (headers always drawn, LD-336)', () => {
    const t = msgClient.map(read).join('\n');
    expect(t).toMatch(/type=["']date["']/);
    expect(t).toMatch(/lims-table-compact|density="compact"/);
    expect(t).toMatch(/emptyState|EmptyRow|PlaceholderRows|EmptyState/);
  });
  it('uses a double submit guard (a ref or busy state) around every write', () => {
    for (const f of msgClient.filter((x) => /Action\(/.test(read(x)))) expect(/useRef|isLoading|isDisabled=\{busy|busy|pending/.test(read(f)), rel(f)).toBe(true);
  });
  it('no dangerouslySetInnerHTML (a ticket message and a template body are plain text; REQ ST16)', () => {
    for (const f of msgClient) expect(read(f), rel(f)).not.toMatch(/dangerouslySetInnerHTML/);
  });
  it('the audience preview is guarded against out of order answers (an abort, a request counter or a version ref)', () => {
    const t = msgClient.filter((f) => /previewBroadcastAudience|previewAudience|Preview/.test(read(f))).map(read).join('\n');
    expect(t).toMatch(/AbortController|useRef|requestId|seq|latest|stale|cancelled|ignore/i);
  });
});

describe('T0D-MSGDESK-1 message catalogue (done_when 4)', () => {
  it('messages.ts holds the broadcast screen text under engagement.msg.* (at least 30 keys) and the ticket screen text under partners.ticket.* (at least 18 keys)', () => {
    expect(msgKeys.length).toBeGreaterThanOrEqual(30);
    expect(ticketKeys.length).toBeGreaterThanOrEqual(18);
  });
  it('every engagement.msg / partners.ticket key used in a component exists in the catalogue', () => {
    const used = new Set(msgClient.flatMap((f) => [...read(f).matchAll(/\bt\(\s*['"]((?:engagement\.msg|partners\.ticket)\.[a-z0-9_.]+)['"]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(messagesSrc, k).toContain(`'${k}'`);
  });
  it('catalogue text is plain: no exclamation mark, no HTML, no development wording (LD-353 rule 8)', () => {
    for (const k of [...msgKeys, ...ticketKeys]) {
      expect(k.text, k.key).not.toMatch(/!|<[a-z/]|TODO|placeholder text|coming soon|T0D-|\bCR-/i);
      expect(k.text.length, k.key).toBeGreaterThan(0);
    }
  });
  it('the blocked-by-permission reasons exist and name the code', () => {
    expect(text('engagement.msg.reason.manage'), 'engagement.msg.reason.manage').toContain('engagement.broadcast.manage');
    expect(text('engagement.msg.reason.approve'), 'engagement.msg.reason.approve').toContain('engagement.broadcast.approve');
    expect(text('partners.ticket.reason.manage'), 'partners.ticket.reason.manage').toContain('partners.ticket.manage');
  });
  it('the approver rule reason says a second person must approve', () => {
    expect(text('engagement.msg.reason.second_person'), 'engagement.msg.reason.second_person').toMatch(/second person/i);
  });
  it('error texts exist for the three refusals the approver can meet: no provider, own request, too many recipients', () => {
    expect(text('engagement.msg.error.provider_not_configured'), 'provider').toMatch(/provider/i);
    expect(text('engagement.msg.error.self_approval'), 'self approval').toMatch(/second person/i);
    expect(text('engagement.msg.error.recipient_limit'), 'limit').toMatch(/5,?000/);
  });
  it('the audience prompt (no party kind chosen yet) and the ticket closed reason exist', () => {
    expect(text('engagement.msg.audience.choose'), 'engagement.msg.audience.choose').toBeTruthy();
    expect(text('partners.ticket.reason.closed'), 'partners.ticket.reason.closed').toMatch(/closed|reopen/i);
  });
});
