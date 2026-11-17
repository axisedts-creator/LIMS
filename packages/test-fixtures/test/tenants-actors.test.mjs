// T0A-05 / TRD §3.5 `tenants` + `actors`. ASSUMED API (see .orchestra/notes/T0A-05-tests.md):
//   src/tenants/index.ts : export const tenants = { tenant_a: T, tenant_b: T }
//     T = { id, name, branches: [{id,name}] x2, centres: [{id, centre_code, name, centre_kind}] x3 }
//   src/actors/index.ts  : export const actors: Actor[]
//     Actor = { key, id, tenantId, actorType: 'user'|'patient'|'partner'|'portal'|'device'|'system',
//               role?, partnerRole?, deviceKind?, aal?: 'aal1'|'aal2', locked: boolean, centreIds?: string[] }
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (p) => import(new URL(p, import.meta.url).href);
const { tenants } = await load('../src/tenants/index.ts');
const { actors } = await load('../src/actors/index.ts');
const { isUuidv7 } = await load('../../shared-ts/src/uuidv7/index.ts');

const ROLES = ['tenant_admin', 'front_desk', 'finance', 'lab_technologist', 'pathologist', 'lab_manager',
  'centre_staff', 'phlebotomist', 'owner_viewer', 'radiologist'];
const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const of = (tid) => actors.filter((a) => a.tenantId === tid);

describe('tenants (TRD §3.5, CV §11.2)', () => {
  it('two permanent tenants with the fixed ids and names', () => {
    assert.deepEqual(Object.keys(tenants).sort(), ['tenant_a', 'tenant_b']);
    assert.equal(tenants.tenant_a.id, A);
    assert.equal(tenants.tenant_a.name, 'Synthetic Lab Alpha');
    assert.equal(tenants.tenant_b.id, B);
    assert.equal(tenants.tenant_b.name, 'Synthetic Lab Beta');
    assert.ok(isUuidv7(A) && isUuidv7(B));
  });
  for (const k of ['tenant_a', 'tenant_b']) {
    it(`${k}: 2 branches, 3 centres, exactly one home_collection pseudo-centre, unique valid ids`, () => {
      const t = tenants[k];
      assert.equal(t.branches.length, 2);
      assert.equal(t.centres.length, 3);
      assert.equal(t.centres.filter((c) => c.centre_kind === 'home_collection').length, 1);
      for (const c of t.centres) {
        assert.ok(['own', 'franchise', 'home_collection'].includes(c.centre_kind));
        assert.match(c.centre_code, /^[A-Za-z0-9-]{1,16}$/);
        assert.ok(c.name.length >= 1 && c.name.length <= 120);
      }
      const ids = [t.id, ...t.branches.map((x) => x.id), ...t.centres.map((x) => x.id)];
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) assert.ok(isUuidv7(id), id);
    });
  }
  it('tenant A and B share no branch/centre ids', () => {
    const ids = (t) => new Set([...t.branches, ...t.centres].map((x) => x.id));
    for (const id of ids(tenants.tenant_a)) assert.ok(!ids(tenants.tenant_b).has(id));
  });
  it('names are synthetic-looking (no real lab names)', () => {
    for (const t of Object.values(tenants)) assert.match(t.name, /^Synthetic Lab /);
  });
});

describe('actors (TRD §3.5)', () => {
  for (const [k, tid] of [['tenant_a', A], ['tenant_b', B]]) {
    describe(k, () => {
      const list = () => of(tid);
      it('one staff actor per default role (10 roles incl. radiologist)', () => {
        for (const r of ROLES) {
          const hits = list().filter((a) => a.actorType === 'user' && a.role === r && !a.locked
            && !(a.centreIds && a.centreIds.length) && !(r === 'finance' && a.aal === 'aal1'));
          assert.equal(hits.length, 1, `role ${r}`);
        }
      });
      it('centre-scoped centre_staff limited to centre 1', () => {
        const hits = list().filter((a) => a.role === 'centre_staff' && a.centreIds?.length);
        assert.equal(hits.length, 1);
        assert.deepEqual(hits[0].centreIds, [tenants[k].centres[0].id]);
      });
      it('one locked user and one aal1-only finance user', () => {
        assert.equal(list().filter((a) => a.locked === true).length, 1);
        assert.equal(list().filter((a) => a.role === 'finance' && a.aal === 'aal1').length, 1);
      });
      it('partner_member + partner_admin partner actors', () => {
        for (const pr of ['partner_member', 'partner_admin']) {
          assert.equal(list().filter((a) => a.actorType === 'partner' && a.partnerRole === pr).length, 1, pr);
        }
      });
      it('one patient, one portal-link actor, bridge_agent + queue_display devices, system actor(s)', () => {
        assert.equal(list().filter((a) => a.actorType === 'patient').length, 1);
        assert.equal(list().filter((a) => a.actorType === 'portal').length, 1);
        assert.equal(list().filter((a) => a.actorType === 'device' && a.deviceKind === 'bridge_agent').length, 1);
        assert.equal(list().filter((a) => a.actorType === 'device' && a.deviceKind === 'queue_display').length, 1);
        assert.ok(list().filter((a) => a.actorType === 'system').length >= 1);
      });
    });
  }
  it('ids are unique UUIDv7, keys unique, every actor belongs to a known tenant', () => {
    assert.equal(new Set(actors.map((a) => a.id)).size, actors.length);
    assert.equal(new Set(actors.map((a) => a.key)).size, actors.length);
    for (const a of actors) {
      assert.ok(isUuidv7(a.id), a.key);
      assert.ok(a.tenantId === A || a.tenantId === B, a.key);
    }
  });
  it('partner_member/partner_admin are never tenant roles (permissions.yaml partner_roles)', () => {
    for (const a of actors) assert.ok(!['partner_member', 'partner_admin'].includes(a.role), a.key);
  });
  it('actor ids are fixed: identical across two module loads', async () => {
    const again = await import(new URL('../src/actors/index.ts?again=1', import.meta.url).href);
    assert.deepEqual(again.actors.map((a) => a.id), actors.map((a) => a.id));
  });
  it('actor/tenant data carries no deliverable email/phone (REQ-SEC-136)', () => {
    const s = JSON.stringify([actors, tenants]);
    for (const m of s.matchAll(/[\w.+-]+@[\w.-]+/g)) assert.match(m[0], /\.invalid$/, m[0]);
    assert.ok(!/\+977|\b9[78]\d{8}\b/.test(s), 'Nepali-looking phone');
  });
  it('fixture source never reads the wall clock or Math.random', () => {
    for (const f of ['tenants', 'actors']) {
      const src = readFileSync(new URL(`../src/${f}/index.ts`, import.meta.url), 'utf8');
      assert.ok(!/Math\.random|Date\.now|new Date\(\)/.test(src), f);
    }
  });
});
