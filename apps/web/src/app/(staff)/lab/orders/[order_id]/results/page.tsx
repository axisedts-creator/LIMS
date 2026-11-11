// 04-UI-UX §3.6 (route /lab/orders/{order_id}/results). A failed read throws → error.tsx (an empty grid would look like "nothing to enter"); a bad or unknown id → notFound (no existence oracle, P-01).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { ResultGrid } from '@/features/lab/components/grid/ResultGrid';
import { listCodedSet, listOrderResults } from '@/features/lab/server/read.server';
import { UUID_RE } from '@/features/lab/server/types';

export const metadata = { title: 'Enter results' };

export default async function ResultsPage({ params, searchParams }: { params: Promise<{ order_id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ order_id }, sp, session] = await Promise.all([params, searchParams, getShellSession()]);
  if (!UUID_RE.test(order_id)) notFound();
  const [data, returnReasons, amendmentReasons] = await Promise.all([
    listOrderResults(order_id, sp).catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; }),
    listCodedSet('return_reasons'),
    listCodedSet('amendment_reasons'),
  ]);
  // ponytail: LabOrderDto / ResultDto carry no patient id, analyte name or decimals (SPEC GAP, C5.T-20-impl.md): the grid falls back to the analyte code and the trend (F3) says it is unavailable.
  return <ResultGrid data={data} analytes={{}} permissions={session?.actor.permissions ?? []} returnReasons={returnReasons} amendmentReasons={amendmentReasons} />;
}
