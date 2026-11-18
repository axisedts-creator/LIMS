// T0D-UILIST-2 (LD-353 rule 6): a list page keeps its title AND its filters when the read fails. 501 operation_pending and every 4xx still throw
// (pendingOr draws NotAvailable, the page's own gate / notFound() handles 4xx); a 500 or above becomes `failure`, which the list passes to DataTable `error`.
export type ListFailure = { requestId?: string };

export async function readList<T>(load: () => Promise<T>): Promise<{ value?: T; failure?: ListFailure }> {
  try {
    return { value: await load() };
  } catch (e) {
    const x = e as { status?: number; problem?: { code?: string; request_id?: string } } | null;
    const pending = x?.status === 501 && x.problem?.code === 'operation_pending';
    if (pending || typeof x?.status !== 'number' || x.status < 500) throw e;
    return { failure: x.problem?.request_id ? { requestId: x.problem.request_id } : {} };
  }
}
