// Decisions (C9 04-UI-UX §2.9, route staff.quality.autoverify_decisions). quality.autoverify.read is checked before any API call; search params are whitelisted in decisionsQuery
// (enum / UUID / ISO instants, period <= 31 days) and a refused period makes NO request. The row drawer (#47) is read by the client only when a row is opened.
import { DecisionsView } from '../_components/DecisionsView';
import { PageNotice } from '../_components/shared';
import { decisionsQuery, gated, getDecisions } from '../_lib/server';
import type { Decision } from '../_lib/types';

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const dq = decisionsQuery(await searchParams);
  const r = await gated(async () => (dq.query ? getDecisions(dq.query) : { rows: [] as Decision[] }));
  if ('gate' in r) return <PageNotice kind={r.gate} title="Auto-verification decisions" helpKey="quality.autoverify_decisions" />;
  const { rows } = r.data;
  const next = 'next' in r.data ? r.data.next : undefined;
  return (
    <DecisionsView
      key={JSON.stringify(dq.clean)} rows={rows} hasPrevious={dq.query?.has('cursor') ?? false} sp={dq.clean}
      {...(next ? { next } : {})} {...(dq.problem ? { problem: dq.problem } : {})}
    />
  );
}
