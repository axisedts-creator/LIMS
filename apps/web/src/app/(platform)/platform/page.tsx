// PL-1 Platform home: tiles for tenants by status, open dead letters, active support sessions, tenants with incomplete IRD annexes.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { StatTile } from '@lims/ui/components/StatTile';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { call, P, platformPermissions } from '@/features/platform/server';
import { PERM, tenantStatusLabel, type AnnexRecord, type DeadLetter, type Fail, type PageOf, type SupportSession, type Tenant } from '@/features/platform/shared';

export const dynamic = 'force-dynamic';

const failed = (f: Fail) => <ErrorState title="Could not load this tile" {...(f.requestId ? { requestId: f.requestId } : {})} />;
const count = (p: PageOf<unknown>) => `${p.data.length}${p.page?.next_cursor ? '+' : ''}`;

export default async function PlatformHomePage() {
  const perms = await platformPermissions();
  if (!perms.has(PERM.read)) return <PermissionDenied />;
  const [tenants, dead, support, annexes] = await Promise.all([
    call<PageOf<Tenant>>(`${P}/tenants?limit=200`),
    perms.has(PERM.deadLetters) ? call<PageOf<DeadLetter>>(`${P}/dead-letters?state=open&limit=200`) : Promise.resolve(undefined),
    call<PageOf<SupportSession>>(`${P}/support-sessions?status=active&limit=200`),
    call<{ data: AnnexRecord[] }>(`${P}/ird-annexes`),
  ]);
  const incomplete = annexes.ok
    ? new Set(annexes.data.data.filter((r) => r.tenant_id && r.status !== 'completed' && r.status !== 'superseded').map((r) => r.tenant_id)).size
    : 0;
  return (
    <section aria-labelledby="pl1-title">
      <h1 id="pl1-title">Platform home</h1>
      <h2>Tenants by status</h2>
      {tenants.ok ? (
        <div className="lims-stat-row">
          {(['active', 'suspended', 'provisioning', 'offboarded'] as const).map((s) => (
            <span key={s}>
              <StatTile label={tenantStatusLabel(s)} value={`${tenants.data.data.filter((t) => t.status === s).length}`} href={`/platform/tenants?status=${s}`} />{' '}
            </span>
          ))}
        </div>
      ) : failed(tenants)}
      <h2>Operations</h2>
      <div className="lims-stat-row">
        {dead === undefined ? null : dead.ok ? <StatTile label="Open dead letters" value={count(dead.data)} href="/platform/dead-letters" /> : failed(dead)}{' '}
        {support.ok ? <StatTile label="Active support sessions" value={count(support.data)} href="/platform/support-sessions" /> : failed(support)}{' '}
        {annexes.ok ? <StatTile label="Tenants with incomplete IRD annexes" value={`${incomplete}`} href="/platform/ird" /> : failed(annexes)}
      </div>
    </section>
  );
}
