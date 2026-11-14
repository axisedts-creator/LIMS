'use client';
// SCR-19 Import detail (04-UI-UX §4; 03-APP-FLOW F-15 steps 2–6). Polls #99 every 2 s while the status is transient (uploaded / scanning / validating /
// committing) and stops after 15 min (the import continues server-side). Reads go through server actions (REQ-SEC-068). Issue text comes from the
// message catalog keyed by issue_code; unknown codes fall back to the API text. Status is always text, never colour alone.
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { StatusStepper } from '@lims/ui/components/StatusStepper';
import { useToast } from '@lims/ui/components/Toast';
import { discardImportAction, listImportIssuesAction, pollImportAction } from '../server/importActions';
import type { Import, ImportIssue, ImportStatus, PriceListLite } from '../server/types';
import { COMMIT_PERMS, IMPORT_STATUS_LABEL, ImportNotice, KIND_LABEL, KIND_PERMS, failText, isTransient, issueText } from './import-shared';
import { ImportCommitDialog } from './ImportCommitDialog';
import { MasterTable, type Col } from './master-ui';
import { GatedButton, fmtDateTime, type Fail } from './shared';

const POLL_MS = 2000;
const POLL_MAX_MS = 15 * 60_000;
const STEPS = [
  { id: 'uploaded', label: 'Uploaded' }, { id: 'scanning', label: 'Security scan' }, { id: 'validating', label: 'Validating' },
  { id: 'validated', label: 'Ready to commit' }, { id: 'committing', label: 'Committing' }, { id: 'committed', label: 'Committed' },
];
type Outcome = { kind: 'failed' | 'cancelled'; label: string };
/** Terminal variants stay on the step they ended at, with text (04-UI-UX SCR-19). */
function stepOf(s: ImportStatus): { currentId: string; outcome?: Outcome } {
  switch (s) {
    case 'invalid': return { currentId: 'validated', outcome: { kind: 'failed', label: IMPORT_STATUS_LABEL.invalid } };
    case 'quarantined': return { currentId: 'scanning', outcome: { kind: 'failed', label: IMPORT_STATUS_LABEL.quarantined } };
    case 'commit_failed': return { currentId: 'committing', outcome: { kind: 'failed', label: IMPORT_STATUS_LABEL.commit_failed } };
    case 'failed': return { currentId: 'validating', outcome: { kind: 'failed', label: IMPORT_STATUS_LABEL.failed } };
    case 'discarded': return { currentId: 'validated', outcome: { kind: 'cancelled', label: IMPORT_STATUS_LABEL.discarded } };
    case 'expired': return { currentId: 'validated', outcome: { kind: 'cancelled', label: IMPORT_STATUS_LABEL.expired } };
    default: return { currentId: s };
  }
}

/** [CONV] Same markup/classes as the kit StatTile, with a space between label and value so the tile reads "Rows 120" in plain text. */
const Tile = ({ label, value }: { label: string; value: number }) => (
  <div className="lims-stat">
    <span className="lims-stat-label">{label}</span> <span className="lims-stat-value">{String(value)}</span>
  </div>
);

type Filter = 'all' | 'error' | 'warning';
type IssueRow = ImportIssue & { id: string };

export function ImportDetail({ importRow, issues: initialIssues, priceList, permissions }: {
  importRow: Import;
  issues: readonly ImportIssue[];
  priceList?: PriceListLite | undefined;
  permissions: readonly string[];
}) {
  const toast = useToast();
  const id = importRow.id;
  const [row, setRow] = useState(importRow);
  const [issues, setIssues] = useState<readonly ImportIssue[]>(initialIssues);
  const [filter, setFilter] = useState<Filter>('all');
  const [timedOut, setTimedOut] = useState(false);
  const [open, setOpen] = useState(false);
  const [fail, setFail] = useState<Fail>();
  const [discarding, setDiscarding] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const live = isTransient(row.status);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    setTimedOut(false);
    const tick = () => {
      timer = setTimeout(async () => {
        if (Date.now() - started >= POLL_MAX_MS) { setTimedOut(true); return; }
        try {
          const r = await pollImportAction(id);
          if (!alive) return;
          if (r.ok) {
            setRow(r.data);
            if (!isTransient(r.data.status)) {
              const i = await listImportIssuesAction(id); // terminal: load the issues once
              if (mounted.current && i.ok) { setIssues(i.data); setFilter('all'); }
              return;
            }
          } else if (r.status === 401 || r.status === 403 || r.status === 404) return;
        } catch {
          /* transient (network / 5xx): the next tick retries; no raw error is shown */
        }
        if (alive) tick();
      }, POLL_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [live, id]);

  const pickFilter = async (f: Filter) => {
    setFilter(f);
    const r = await listImportIssuesAction(id, f === 'all' ? undefined : f);
    if (mounted.current && r.ok) setIssues(r.data);
  };

  const discard = async () => {
    if (discarding) return;
    setDiscarding(true);
    setFail(undefined);
    try {
      const r = await discardImportAction(id, row.version);
      if (r.ok) { setRow(r.data); toast.show({ tone: 'success', title: 'Import discarded' }); } else setFail(r);
    } finally {
      setDiscarding(false);
    }
  };

  const s = row.status;
  const missingCommit = COMMIT_PERMS[row.kind].filter((p) => !permissions.includes(p));
  const missingManage = KIND_PERMS[row.kind].filter((p) => !permissions.includes(p));
  const canCommit = s === 'validated' || s === 'commit_failed';
  const canDiscard = s === 'validated' || s === 'invalid' || s === 'commit_failed';
  const hasReport = s === 'validated' || s === 'invalid' || s === 'commit_failed' || s === 'committed';
  const showIssues = s !== 'quarantined' && !live && s !== 'discarded' && s !== 'expired' && s !== 'failed';
  const { currentId, outcome } = stepOf(s);
  const sum = row.summary;
  const target = priceList?.code ?? (row.target_price_list_id ? '—' : undefined);

  const cols: Col<IssueRow>[] = [
    { header: 'Severity', cell: (r) => (r.severity === 'error' ? 'Error' : 'Warning') },
    { header: 'Sheet', cell: (r) => r.sheet },
    { header: 'Row', cell: (r) => (r.row_no === undefined ? '—' : String(r.row_no)) },
    { header: 'Column', cell: (r) => r.column ?? '—' },
    { header: 'Issue', cell: (r) => issueText(r) },
  ];

  return (
    <section aria-label="Import detail">
      <PageHeader title={row.file_name} helpKey="catalog.imports" breadcrumbs={[{ label: 'Pricing' }, { label: 'Imports & exports', href: '/catalog/imports' }, { label: row.file_name }]} />
      <p>
        {KIND_LABEL[row.kind]}
        {target ? ` · Price list ${target}` : ''}
        {row.base_version_no ? ` · Based on version ${row.base_version_no}` : ''}
        {` · Uploaded ${fmtDateTime(row.created_at)}`}
      </p>
      <StatusStepper steps={STEPS} currentId={currentId} {...(outcome ? { outcome } : {})} />
      {timedOut && live ? <Banner tone="info" title="This is taking longer than expected. You can leave this page; the import continues." /> : null}
      {s === 'quarantined' ? <ImportNotice tone="danger" text="This file was blocked by the security scan. It was not read." /> : null}
      {s === 'invalid' ? <ImportNotice tone="danger" text="The file has errors, so it cannot be committed. Fix them in the annotated file and upload it again." /> : null}
      {s === 'commit_failed' ? <ImportNotice tone="danger" text="The commit failed and nothing was applied. Check the issues below; you can commit again." /> : null}
      {s === 'failed' ? <ImportNotice tone="danger" text="The import failed. Upload the file again." /> : null}
      {s === 'committed' ? (
        <Banner tone="success" title="The import was committed.">
          {row.result_price_list_version_id && row.target_price_list_id ? (
            <a className="lims-link" href={`/catalog/price-lists/${row.target_price_list_id}/versions/${row.result_price_list_version_id}`}>Open the new price list version</a>
          ) : null}
        </Banner>
      ) : null}
      {fail ? <ImportNotice tone={fail.code === 'auth.mfa_required' ? 'warning' : 'danger'} text={failText(fail)} /> : null}

      {s !== 'quarantined' ? (
        <div className="lims-inline catalog-gap-3 catalog-wrap">
          <Tile label="Rows" value={sum.rows} />
          <Tile label="Added" value={sum.added} />
          <Tile label="Changed" value={sum.changed} />
          <Tile label="Removed" value={sum.removed} />
          <Tile label="Unchanged" value={sum.unchanged} />
          <Tile label="Errors" value={sum.errors} />
          <Tile label="Warnings" value={sum.warnings} />
        </div>
      ) : null}

      <div className="lims-inline catalog-gap-3">
        {hasReport ? <a className="lims-link" href={`/catalog/imports/${id}/report`}>Download annotated file</a> : null}
        {canDiscard ? <GatedButton missing={missingManage} variant="secondary" isLoading={discarding} onPress={() => void discard()}>Discard</GatedButton> : null}
        {canCommit ? <GatedButton missing={missingCommit} variant="primary" onPress={() => setOpen(true)}>Commit…</GatedButton> : null}
      </div>

      {showIssues ? (
        <section aria-labelledby="imp-issues" className="lims-stack">
          <h2 id="imp-issues">Issues</h2>
          <RadioGroup<Filter>
            label="Show"
            name="severity"
            orientation="horizontal"
            value={filter}
            onChange={(f) => void pickFilter(f)}
            options={[{ value: 'all', label: 'All' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }]}
          />
          <MasterTable caption="Import issues" cols={cols} rows={issues.map((i) => ({ ...i, id: String(i.seq) }))} empty="No issues." />
        </section>
      ) : null}

      {open ? (
        <ImportCommitDialog
          row={row}
          issues={issues}
          priceList={priceList}
          isOpen
          onClose={() => setOpen(false)}
          onCommitted={(r) => { setRow(r); toast.show({ tone: 'success', title: 'Commit started' }); }}
        />
      ) : null}
    </section>
  );
}
