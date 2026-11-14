// 04-UI-UX §4.3 Labels page — server component via the BFF. One render = one GET /cases/{id}/labels = one `anatomic_label.print` access-log row (written by the API, 08 A17 D-53).
// A malformed case id never reaches the API (REQ-SEC-026/027); `kind` is an allow-list; `ids` is forwarded only as a csv of at most 200 UUIDs (REQ-SEC-100), otherwise dropped.
// Needs anatomic.case.work (x-permission of getAnatomicLabels): without it, no API call. 404/400 → notFound(); 403 → no-access state; other failures reject to error.tsx.
// LD-140 (2026-11-13): the sheet is built from the kit only (see LabelSheet).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { AnatomicForbidden } from '@/features/anatomic/components/AnatomicForbidden';
import { LabelSheet } from '@/features/anatomic/components/material/LabelSheet';
import { getLabels } from '@/features/anatomic/server/reads.server';
import { isUuid, orForbidden, orMissing } from '@/features/anatomic/server/shared';

const validIds = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const parts = v.split(',');
  return parts.length >= 1 && parts.length <= 200 && parts.every(isUuid) ? v : undefined;
};

export default async function LabelsPage({ params, searchParams }: { params: Promise<{ case_id: string }>; searchParams: Promise<{ kind?: string | string[]; ids?: string | string[] }> }) {
  const { case_id } = await params;
  if (!isUuid(case_id)) notFound();
  const sp = await searchParams;
  const kind = sp.kind === 'slides' ? 'slides' : 'blocks';
  const ids = validIds(sp.ids);
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('anatomic.case.work')) return <AnatomicForbidden />;
  const labels = await orForbidden(() => orMissing(() => getLabels(case_id, kind, ids)));
  if (labels === null) return <AnatomicForbidden />;
  if (labels === undefined) notFound();
  return <LabelSheet caseId={case_id} kind={kind} labels={labels} />;
}
