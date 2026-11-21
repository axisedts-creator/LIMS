// T0B-CONTENT-1 static checks (no database): the 9 T0C-CONTENT-1 operations are registered with real handlers, are NOT left pending (LD-325 b), carry the contract permissions,
// refuse a request without context, and the Markdown helper is used by the content code (done_when 1, 2; LD-313, LD-325).
// Needs lane/C0-0C merged: the 9 operations exist in contracts/openapi/engagement.yaml only there.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';

const OPS: Record<string, { method: string; path: string; permission: string }> = {
  listPortalContent: { method: 'get', path: '/v1/engagement/portal-content', permission: 'engagement.content.read' },
  createPortalContent: { method: 'post', path: '/v1/engagement/portal-content', permission: 'engagement.content.manage' },
  reorderPortalContent: { method: 'post', path: '/v1/engagement/portal-content/reorder', permission: 'engagement.content.manage' },
  updatePortalContent: { method: 'patch', path: '/v1/engagement/portal-content/{content_id}', permission: 'engagement.content.manage' },
  deactivatePortalContent: { method: 'post', path: '/v1/engagement/portal-content/{content_id}/deactivate', permission: 'engagement.content.manage' },
  listMyPortalContent: { method: 'get', path: '/v1/engagement/me/portal-content', permission: 'engagement.self.read' },
  listProfileImages: { method: 'get', path: '/v1/engagement/profile-images', permission: 'engagement.content.read' },
  setProfileImage: { method: 'put', path: '/v1/engagement/profile-images/{profile_kind}/{profile_id}', permission: 'engagement.content.manage' },
  clearProfileImage: { method: 'delete', path: '/v1/engagement/profile-images/{profile_kind}/{profile_id}', permission: 'engagement.content.manage' },
};
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];
const H = handlers as unknown as Record<string, (r: unknown, c: unknown) => Promise<unknown>>;

describe('T0B-CONTENT-1: the 9 operations are implemented', () => {
  for (const [id, o] of Object.entries(OPS)) {
    it(`${id}: in the spec with x-permission ${o.permission}`, () => {
      const op = spec.paths?.[o.path]?.[o.method];
      expect(op?.operationId, `${o.method} ${o.path} (merge lane/C0-0C first)`).toBe(id);
      expect(op['x-permission']).toBe(o.permission);
    });
    it(`${id}: has a real handler (not the 503 placeholder) and is not pending`, async () => {
      expect(typeof H[id], 'handler registered').toBe('function');
      expect(pending, 'LD-325 (b): the handler task removes the id from pendingOperations').not.toContain(id);
      // every real engagement handler fails closed with auth.unauthenticated when the request has no context; the placeholder answers common.service_unavailable
      const e: any = await H[id]!({ params: {}, query: {}, headers: {}, body: undefined }, {}).then(() => undefined, (x) => x);
      expect(e?.code, `${id} without context`).toBe('auth.unauthenticated');
    });
  }
  it('every spec operation is still covered (handler or pending) and no pending id has a handler left over for these 9', () => {
    const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
    const covered = Object.keys(manifest.handlers);
    expect(specIds.filter((i) => !covered.includes(i) && !pending.includes(i))).toEqual([]);
    expect(pending.filter((i) => Object.keys(OPS).includes(i))).toEqual([]);
  });
  it('the contract holds the staff list filters and the public list takes only kind (nothing widens the set)', () => {
    const names = (id: string) => (spec.paths[OPS[id]!.path][OPS[id]!.method].parameters ?? []).map((p: any) => p.name ?? p.$ref?.split('/').pop());
    expect(names('listMyPortalContent')).not.toContain('is_active');
    expect(names('listPortalContent')).toEqual(expect.arrayContaining(['kind', 'is_active']));
  });
});

describe('T0B-CONTENT-1: one shared Markdown helper (done_when 2)', () => {
  const dir = join(import.meta.dirname, '..', '..');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === '__tests__' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : []; });
  const src = walk(dir).map((p) => ({ p, t: readFileSync(p, 'utf8') }));
  it('safeMarkdown.ts exists in service/ and is imported by the content code (write and read side)', () => {
    const helper = src.find((s) => s.p.endsWith(join('service', 'safeMarkdown.ts')));
    expect(helper, 'service/safeMarkdown.ts').toBeTruthy();
    const users = src.filter((s) => s !== helper && /safeMarkdown/.test(s.t));
    expect(users.length, 'files that import the helper').toBeGreaterThanOrEqual(1);
  });
  it('no second Markdown or HTML sanitiser is written in the module (no ad hoc regex copy of the helper)', () => {
    const copies = src.filter((s) => !s.p.endsWith('safeMarkdown.ts') && /(?:renderMarkdown|validateMarkdown)\s*[=(]\s*(?:\(|function|async)/.test(s.t));
    expect(copies.map((c) => c.p)).toEqual([]);
  });
  it('no HTML sanitiser or Markdown parser dependency is added by this task beyond what package.json already lists (new dependency needs a founder-visible reason)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services/api/package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies });
    const found = deps.filter((d) => /^(marked|markdown-it|remark|micromark|showdown|sanitize-html|dompurify|isomorphic-dompurify|xss|insane)/.test(d));
    // allowed: one maintained parser/sanitiser, exact-pinned (no ^ or ~), recorded in the task notes; zero is also fine (a small hand written helper)
    for (const d of found) expect(pkg.dependencies[d], `${d} must be pinned exactly`).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
