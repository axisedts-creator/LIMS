// CR TENANT-LOGO-1, LIVE database (real migrations, FORCE row level security, the audit trigger): the statements behind
// uploadBrandingAssetAsPlatform and getOwnTenantLogoContent, run through the real core Db (requestTx + withTenantScope) with the real repos.
// Skipped without LIMS_TEST_APP_URL. Run: bash tests/identity/TENANT-LOGO-1.pg.sh (boots a throwaway PG17 like tests/frontdesk/FD-T03.pg.sh).
// Every case rolls its transaction back, so the database is left as it was. Synthetic tenants of db/seeds/010 only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Tx } from '../../../../core/db/tx.js';
import { createSettingsRepo } from '../../repository/settings.repo.js';
import { createTenantRepo } from '../tenant.service.js';

const URL_APP = process.env['LIMS_TEST_APP_URL'];
const A = '01a1a98a-ac40-7000-8000-00000000a001', B = '01a1a98a-ac40-7000-8000-00000000b001';   // tenant_a, tenant_b (seed 010)
const STAFF = '01a1a98a-ac40-7000-8000-0000000fa001';        // synthetic platform staff user id (no row needed: created_by has no FK)
const ASSET = '01a1a98a-ac40-7000-8000-0000000fa0a1';
const SHA = 'ab'.repeat(32);
const ROLLBACK = new Error('rollback (test)');
const noop = () => undefined;
const log = { info: noop, warn: noop, error: noop } as any;
const metrics = { inc: noop, setGauge: noop, set: noop, observe: noop } as any;

describe.skipIf(!URL_APP)('tenant logo on a live database (RLS, platform scope)', () => {
  let pool: any; let db: Db;
  const settings = createSettingsRepo(); const tenants = createTenantRepo();
  const platformClaims = { sub: STAFF, actor_type: 'user', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' } as any;
  const staffClaims = (tenant_id: string) => ({ sub: STAFF, actor_type: 'user', tenant_id }) as any;
  const op = (operationId: string, context: string) => ({ module: 'identity', operationId, context });
  /** runs fn in a request transaction and ALWAYS rolls it back; returns what fn returned */
  const inTx = async <T>(claims: unknown, operation: ReturnType<typeof op>, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    let out: T | undefined; let done = false;
    await db.requestTx({ claims: claims as any, requestId: ASSET, clientIp: '203.0.113.9', operation }, async (tx) => { out = await fn(tx); done = true; throw ROLLBACK; })
      .catch((e) => { if (!done) throw e; });
    return out as T;
  };
  const row = (tenantId: string) => ({
    id: ASSET, tenant_id: tenantId, kind: 'logo', membership_id: null, bucket: 'identity-assets', object_path: `${tenantId}/branding/${ASSET}.png`,
    content_type: 'image/png', size_bytes: 120, width_px: 40, height_px: 12, sha256: SHA, scan_state: 'clean' as const, actorId: STAFF,
  });
  /** what uploadBrandingAssetAsPlatform writes for `tenantId`, inside ONE scope window */
  const platformWrite = (tx: Tx, tenantId: string) => db.withTenantScope(tx, tenantId, async () => {
    await tx.query(`INSERT INTO identity.tenant_settings (tenant_id, timezone, legal_name_snapshot, display_name, created_by, updated_by)
      VALUES ($1, 'Asia/Kathmandu', 'Synthetic', 'Synthetic', $2, $2) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, STAFF]);
    await settings.insertAsset(tx, tenantId, row(tenantId));
    await settings.setAssetPointer(tx, tenantId, 'logo_asset_id', ASSET, STAFF);
    await tenants.accessLog(tx, tenantId, { action: 'settings.change', entityType: 'tenant_settings', entityId: tenantId, outcome: 'allowed', detail: { fields: 'logo_asset_id' } },
      { actor: { type: 'user', id: STAFF }, requestId: ASSET });
  });

  beforeAll(async () => {
    const { default: Pg } = await import('pg');
    pool = new Pg.Pool({ connectionString: URL_APP, max: 2 });
    const actor = (await pool.query(`SELECT actor_id FROM core.g_system_actors WHERE module = 'identity' AND is_active`)).rows[0].actor_id as string;
    db = createDb({ pool, log, metrics, scopeActorId: async () => actor });
  });
  afterAll(async () => { await pool?.end(); });

  it('platform upload path: row + pointer + access-log line are accepted under RLS inside withTenantScope(tenant_a)', async () => {
    const seen = await inTx(platformClaims, op('uploadBrandingAssetAsPlatform', 'platform'), async (tx) => {
      await platformWrite(tx, A);
      // read back as tenant_a would (inside the scope again: platform claims themselves see no tenant rows)
      return db.withTenantScope(tx, A, async () => ({ asset: await settings.findAsset(tx, A, ASSET), s: await settings.findSettings(tx, A) }));
    });
    expect(seen.asset).toMatchObject({ id: ASSET, tenant_id: A, kind: 'logo', object_path: `${A}/branding/${ASSET}.png`, sha256: SHA, scan_state: 'clean' });
    expect(seen.s?.['logo_asset_id']).toBe(ASSET);
  });

  it('tenant separation in the database: tenant_b claims cannot see tenant_a logo, by repo lookup or by raw id', async () => {
    const seen = await inTx(platformClaims, op('uploadBrandingAssetAsPlatform', 'platform'), async (tx) => {
      await platformWrite(tx, A);
      return db.withTenantScope(tx, B, async () => ({
        viaRepoAsB: await settings.findAsset(tx, B, ASSET),
        viaRepoNamingA: await settings.findAsset(tx, A, ASSET),          // even asking for tenant_a's row: RLS hides it from tenant_b claims
        raw: (await tx.query('SELECT count(*)::int AS n FROM identity.branding_assets WHERE id = $1', [ASSET])).rows[0].n,
        settingsOfA: (await tx.query('SELECT count(*)::int AS n FROM identity.tenant_settings WHERE tenant_id = $1', [A])).rows[0].n,
      }));
    });
    expect(seen).toEqual({ viaRepoAsB: undefined, viaRepoNamingA: undefined, raw: 0, settingsOfA: 0 });
  });

  it('a row for tenant_a cannot be written while scoped to tenant_b (RLS WITH CHECK), nor with a key outside the tenant (path CHECK)', async () => {
    const wrongScope = await inTx(platformClaims, op('uploadBrandingAssetAsPlatform', 'platform'), (tx) =>
      db.withTenantScope(tx, B, () => tx.savepoint(() => settings.insertAsset(tx, A, row(A))).then(() => 'written', (e: any) => String(e?.code ?? e?.message))));
    expect(wrongScope).not.toBe('written');
    const wrongPath = await inTx(platformClaims, op('uploadBrandingAssetAsPlatform', 'platform'), (tx) =>
      db.withTenantScope(tx, A, () => tx.savepoint(() => settings.insertAsset(tx, A, { ...row(A), object_path: `${B}/branding/${ASSET}.png` })).then(() => 'written', (e: any) => String(e?.code ?? e?.message))));
    expect(wrongPath).not.toBe('written');
  });

  it('platform claims WITHOUT a tenant scope cannot write the row (no tenant in the claims)', async () => {
    const r = await inTx(platformClaims, op('uploadBrandingAssetAsPlatform', 'platform'), (tx) =>
      tx.savepoint(() => settings.insertAsset(tx, A, row(A))).then(() => 'written', (e: any) => String(e?.code ?? e?.message)));
    expect(r).not.toBe('written');
  });

  it('the scope is refused for an operation that is not on the allowlist, and for a tenant (non platform) request', async () => {
    const notListed = await inTx(platformClaims, op('listTenants', 'platform'), (tx) => db.withTenantScope(tx, A, async () => 'scoped').catch((e: any) => e?.code));
    expect(notListed).toBe('common.internal');
    const tenantCtx = await inTx(staffClaims(B), op('uploadBrandingAssetAsPlatform', 'tenant'), (tx) => db.withTenantScope(tx, A, async () => 'scoped').catch((e: any) => e?.code));
    expect(tenantCtx).toBe('common.internal');
  });

  it('staff read path: a tenant_a staff request finds its own logo; a tenant_b staff request finds nothing', async () => {
    // one transaction: platform writes for A, then the claims are switched as two later staff requests would carry them
    const seen = await inTx(platformClaims, op('uploadBrandingAssetAsPlatform', 'platform'), async (tx) => {
      await platformWrite(tx, A);
      const as = async (claims: unknown) => {
        await tx.query(`SELECT set_config('request.jwt.claims', $1::text, true)`, [JSON.stringify(claims)]);
        const s = await settings.findSettings(tx, A); const id = s?.['logo_asset_id'];
        return { pointer: id ?? null, asset: typeof id === 'string' ? (await settings.findAsset(tx, A, id))?.id ?? null : null };
      };
      return { a: await as(staffClaims(A)), b: await as(staffClaims(B)) };
    });
    expect(seen.a).toEqual({ pointer: ASSET, asset: ASSET });
    expect(seen.b).toEqual({ pointer: null, asset: null });
  });
});
