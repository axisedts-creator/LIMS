// PL-8 Sign-in events (platform.tenant.read). listPlatformAuthEvents requires occurred_at_from/to; the range is capped at 31 days.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { AuthEventFilters, AuthEventTable, type AuthEventFilter } from '@/features/platform/AuthEvents';
import { call, one, P, platformPermissions, qs, type SP } from '@/features/platform/server';
import { AUTH_EVENT_TYPES, PERM, isUuid, type AuthEvent, type PageOf, type Tenant } from '@/features/platform/shared';

export const dynamic = 'force-dynamic';
const DAY = 86_400_000;
const MAX_SPAN = 31 * DAY;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export default async function AuthEventsPage({ searchParams }: { searchParams?: SP }) {
  const perms = await platformPermissions();
  if (!perms.has(PERM.read)) return <PermissionDenied />;
  const sp = (await searchParams) ?? {};
  const now = Date.now();
  const rawFrom = one(sp['occurred_at_from']);
  const rawTo = one(sp['occurred_at_to']);
  const to = rawTo && ISO.test(rawTo) && !Number.isNaN(Date.parse(rawTo)) ? Date.parse(rawTo) : now;
  const from = rawFrom && ISO.test(rawFrom) && !Number.isNaN(Date.parse(rawFrom)) ? Date.parse(rawFrom) : to - 7 * DAY;
  const rangeError = to <= from ? 'The end of the range must be after its start.' : to - from > MAX_SPAN ? 'Choose a date range of at most 31 days.' : undefined;
  const tenantParam = one(sp['tenant_id']);
  const tenant = tenantParam === 'none' || isUuid(tenantParam) ? tenantParam : '';
  const eventParam = one(sp['event_type']);
  const eventType = eventParam && (AUTH_EVENT_TYPES as readonly string[]).includes(eventParam) ? eventParam : '';
  const filter: AuthEventFilter = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tenant, event_type: eventType };

  const [tenants, events] = await Promise.all([
    call<PageOf<Tenant>>(`${P}/tenants?limit=200`),
    rangeError ? Promise.resolve(undefined) : call<PageOf<AuthEvent>>(`${P}/auth-events${qs({
      occurred_at_from: filter.from, occurred_at_to: filter.to, tenant_id: isUuid(tenant) ? tenant : undefined, event_type: eventType || undefined, limit: '50',
    })}`),
  ]);
  const tenantRefs = tenants.ok ? tenants.data.data.map((t) => ({ tenant_id: t.tenant_id, code: t.code })) : [];
  // [CONV] "No tenant" has no API parameter (.orchestra/cr/C2.T26.md): tenant-less rows are filtered here, on the loaded page only.
  const rows = events?.ok ? events.data.data.filter((e) => tenant !== 'none' || !e.tenant_id) : [];
  return (
    <section aria-labelledby="pl8-title">
      <h1 id="pl8-title">Sign-in events</h1>
      <AuthEventFilters initial={filter} tenants={tenantRefs} />
      {rangeError ? <p role="alert" className="lims-error">{rangeError}</p>
        : events && !events.ok ? <ErrorState title="Could not load sign-in events" {...(events.requestId ? { requestId: events.requestId } : {})} />
          : <AuthEventTable rows={rows} tenants={tenantRefs} />}
    </section>
  );
}
