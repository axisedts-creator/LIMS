// C13.T19 PS-1 Statements — /statements (04-UI-UX PS-1). S1 listPartnerStatements (period_month_from/_to, cursor). Read-only.
import { get, query, type Paged, type Search } from '@/features/common/api';
import type { Money, StatementMonth } from '@/features/common/types';
import { StatementList } from '@/features/statements/StatementViews';

const RULES = { period_month_from: 'month', period_month_to: 'month', cursor: 'cursor' } as const;
type Body = Paged<StatementMonth> & { outstanding?: Money; outstanding_as_of?: string };

export default async function StatementsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const body = await get<Body>(`/v1/partners/statements${query(await searchParams, RULES)}`);
  if (!Array.isArray(body.data)) throw new Error('partner_api_failed');
  return <StatementList rows={body.data} nextCursor={body.page?.next_cursor} outstanding={body.outstanding} asOf={body.outstanding_as_of} />;
}
