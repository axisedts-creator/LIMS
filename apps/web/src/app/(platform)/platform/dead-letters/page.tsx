// PL-6 Dead letters (platform.dead_letter.manage). URL filters are validated, then forwarded as listDeadLetters params;
// platform_rows=true is never sent together with tenant_id (the API answers 400 common.validation_failed).
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { DeadLetterFilters, DeadLetterTable, type DeadLetterFilter } from '@/features/platform/DeadLetters';
import { call, one, P, platformPermissions, qs, type SP } from '@/features/platform/server';
import { DEAD_LETTER_STATES, PERM, isUuid, type DeadLetter, type PageOf, type Tenant } from '@/features/platform/shared';

export const dynamic = 'force-dynamic';
const DAY_OR_TS = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const TASK = /^[a-z0-9_.:-]{1,200}$/i;

export default async function DeadLettersPage({ searchParams }: { searchParams?: SP }) {
  const perms = await platformPermissions();
  if (!perms.has(PERM.deadLetters)) return <PermissionDenied />;
  const sp = (await searchParams) ?? {};
  const state = one(sp['state']);
  const platformRows = one(sp['platform_rows']) === 'true';
  const tenantId = one(sp['tenant_id']);
  const task = one(sp['task_identifier']);
  const from = one(sp['dead_at_from']);
  const to = one(sp['dead_at_to']);
  const filter: DeadLetterFilter = {
    state: state && (DEAD_LETTER_STATES as readonly string[]).includes(state) ? state : 'open',
    platform_rows: platformRows,
    tenant_id: !platformRows && isUuid(tenantId) ? tenantId : '',
    task_identifier: task && TASK.test(task) ? task : '',
    dead_at_from: from && DAY_OR_TS.test(from) ? from : '',
    dead_at_to: to && DAY_OR_TS.test(to) ? to : '',
  };
  const [tenants, rows] = await Promise.all([
    call<PageOf<Tenant>>(`${P}/tenants?limit=200`),
    call<PageOf<DeadLetter>>(`${P}/dead-letters${qs({
      state: filter.state, platform_rows: filter.platform_rows ? 'true' : undefined, tenant_id: filter.tenant_id || undefined,
      task_identifier: filter.task_identifier || undefined, dead_at_from: filter.dead_at_from || undefined, dead_at_to: filter.dead_at_to || undefined, limit: '50',
    })}`),
  ]);
  const tenantRefs = tenants.ok ? tenants.data.data.map((t) => ({ tenant_id: t.tenant_id, code: t.code })) : [];
  return (
    <section aria-labelledby="pl6-title">
      <h1 id="pl6-title">Dead letters</h1>
      <DeadLetterFilters initial={filter} tenants={tenantRefs} />
      {rows.ok ? <DeadLetterTable rows={rows.data.data} tenants={tenantRefs} />
        : <ErrorState title="Could not load dead letters" {...(rows.requestId ? { requestId: rows.requestId } : {})} />}
    </section>
  );
}
