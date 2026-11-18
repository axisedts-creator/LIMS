// T0D-UILIST-3, LD-353 rule 6: a list page whose load failed renders PageError inside the page instead of throwing to error.tsx.
// Plain module (no 'use client', no server-only) so a server page can call it. Next control-flow throws (notFound, redirect:
// digest NEXT_*) are re-thrown. Returns the request id to show as the reference ('' if none); never the problem text.
export function failedRequestId(e: unknown): string {
  const digest = (e as { digest?: unknown } | null)?.digest;
  if (typeof digest === 'string' && digest.startsWith('NEXT_')) throw e;
  const id = (e as { problem?: { request_id?: unknown } } | null)?.problem?.request_id;
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? id : '';
}
