'use client';
// 04-UI-UX §4.2.2 Parts & gross tab: one card per part, [Add part]. People without anatomic.case.work see values only.
// LD-140 (2026-11-13): kit components only; the Save buttons are secondary (the page's one primary button lives in the header).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { AddPartDialog } from '../forms/AddPartDialog';
import { PartForm, PartReadOnly } from '../forms/PartForm';
import type { CaseDetail, TextTemplate } from '../server/types';
import type { Fail } from './common';

export function PartsTab({ detail, canWork, templates, onFail, onMfa }: { detail: CaseDetail; canWork: boolean; templates: readonly TextTemplate[]; onFail: (f: Fail) => void; onMfa: () => void }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  return (
    <>
      {canWork ? <Button onPress={() => setAdding(true)}>Add part</Button> : null}
      {detail.parts.length === 0 ? (
        <EmptyState title="No parts yet. Parts are created when specimens are received, or add one." />
      ) : (
        detail.parts.map((p) =>
          canWork ? (
            <PartForm key={p.id} caseId={detail.id} caseStatus={detail.status} part={p} templates={templates} onFail={onFail} onMfa={onMfa} />
          ) : (
            <PartReadOnly key={p.id} part={p} />
          ),
        )
      )}
      {canWork ? (
        <AddPartDialog
          key={detail.parts.length}
          caseId={detail.id}
          status={detail.status}
          isOpen={adding}
          onClose={() => setAdding(false)}
          onMfa={onMfa}
          onDone={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
