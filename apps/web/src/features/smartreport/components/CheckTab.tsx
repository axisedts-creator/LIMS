'use client';
// SR-04 "Check & submit": Run checks (#18) -> issues table; Submit for approval (#19, If-Match) only after a check run without errors.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { submitAction, validateAction } from '../server/actions';
import type { Issue } from '../library';
import { ErrorAlert, useEditor } from './common';
import { PreviewDialog } from './PreviewDialog';

const TAB_NAME: Record<string, string> = { texts: 'Texts', rules: 'Rules', mapping: 'Analyte mapping' };
const owner = (i: Issue) => (i.block_key ? 'texts' : i.rule_id ? 'rules' : 'mapping');

export type Numbered = Issue & { n: number };
/** `issues` lives in the editor so the last check run survives a jump to another tab. */
export function CheckTab({ version, onJump, issues, setIssues, canPreviewOrder }: { version: number; onJump: (tab: string) => void; issues: Numbered[] | undefined; setIssues: (i: Numbered[]) => void; canPreviewOrder: boolean }) {
  const ed = useEditor();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const hasErrors = !!issues?.some((i) => i.severity === 'error');

  const check = async () => {
    setBusy(true); setAlert(undefined);
    try {
      const r = await validateAction(ed.versionId);
      if (r.ok) setIssues(r.data.map((i, n) => ({ ...i, n })));
      else setAlert(ed.failed(r));
    } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setAlert(undefined);
    try {
      const r = await submitAction(ed.versionId, version);
      if (r.ok) { router.push('/smartreport/library'); return; }
      const t = ed.failed(r);
      if (r.code !== 'smartreport.library_invalid_transition') setAlert(t);
    } finally { setBusy(false); }
  };

  const columns: ColumnDef<Numbered>[] = [
    { id: 'severity', header: 'Severity', cell: (i) => <StatusChip kind="generic" status={i.severity} label={i.severity === 'error' ? 'Error' : i.severity === 'warning' ? 'Warning' : i.severity} tone={i.severity === 'error' ? 'danger' : 'warning'} /> },
    { id: 'code', header: 'Code', isRowHeader: true, cell: (i) => i.code },
    { id: 'where', header: 'Where', cell: (i) => i.block_key ?? (i.rule_id ? 'Rule' : i.path ?? '—') },
    { id: 'detail', header: 'Detail', cell: (i) => i.detail ?? '' },
    { id: 'go', header: 'Actions', cell: (i) => <Button size="sm" variant="ghost" onPress={() => onJump(owner(i))}>{`Go to ${TAB_NAME[owner(i)]}`}</Button> },
  ];

  if (ed.readOnly) return <p>Checks and submission are available on drafts only.</p>;
  return (
    <div>
      <ErrorAlert text={alert} />
      <span className="lims-inline">
        <Button onPress={() => void check()} isDisabled={busy}>Run checks</Button>
        <Button onPress={() => setPreviewing(true)}>Preview</Button>
        <Button variant="primary" onPress={() => void submit()} isDisabled={busy || !issues || hasErrors}>Submit for approval</Button>
      </span>
      {issues && issues.length === 0 ? <p role="status">No issues found. You can submit this version for approval.</p> : null}
      {issues && issues.length > 0 ? (
        <DataTable columns={columns} rows={issues} getRowId={(i) => String(i.n)} caption="Issues" density="compact" emptyState={{ title: 'No issues found' }} />
      ) : null}
      <PreviewDialog versionId={ed.versionId} canPreviewOrder={canPreviewOrder} isOpen={previewing} onClose={() => setPreviewing(false)} />
    </div>
  );
}
