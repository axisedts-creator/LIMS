// 04-UI-UX §3.6 (route /lab/orders/{order_id}/results). A failed read throws → error.tsx (an empty grid would look like "nothing to enter"); a bad or unknown id → notFound (no existence oracle, P-01).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { ResultGrid } from '@/features/lab/components/grid/ResultGrid';
import { getAnalytes, listCodedSet, listOrderResults } from '@/features/lab/server/read.server';
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
  // Review C5.T-20 #1: name / result_type / decimals from C3 getAnalyte. No patient id on LabOrderDto (CR .orchestra/cr/C5.T-20.md): F3 says the trend is unavailable until ruled.
  const analytes = await getAnalytes(data.items.flatMap((i) => i.results.map((r) => r.analyte_id)));
  return <ResultGrid data={data} analytes={analytes} permissions={session?.actor.permissions ?? []} returnReasons={returnReasons} amendmentReasons={amendmentReasons} />;
}
