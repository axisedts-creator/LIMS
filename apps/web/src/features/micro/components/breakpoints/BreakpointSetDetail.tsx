'use client';
// 04-UI-UX §6.2 Breakpoint set detail (AC-12.2, AC-13.1, AC-13.3, AC-13.5). Polls every 2 s while uploaded/validating (ASSUMED interval, same as C3 SCR-19);
// reads go through server actions (REQ-SEC-068). All server text (title, licence text, issue messages) is rendered as text nodes (REQ-SEC-088, S-13).
// Actions: Activate (four-eyes copy comes from the API error), Retire (danger confirm), Discard. LD-140: one primary button; status = tone + icon + word.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Spinner } from '@lims/ui/components/Spinner';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import {
  activateBreakpointSetAction, discardBreakpointSetAction, listBreakpointIssuesAction, listBreakpointRowsAction, pollBreakpointSetAction, retireBreakpointSetAction,
} from '../../server/actions';
import type { ActionResult, BreakpointBandDto, BreakpointImportIssueDto, BreakpointRowDto, BreakpointSetDto } from '../../server/types';
import { asIso, Chip, FailNotice, PERM, When, type Fail, type IsoUtc } from '../common';
import { BreakpointStatusChip, isChecking } from './status';

const POLL_MS = 2000;
const CHECKING = 'Checking the file… this page updates automatically.';
const bytes = (n: number) => `${n.toLocaleString('en-US')} bytes (${Math.max(1, Math.round(n / 1024)).toLocaleString('en-US')} KiB)`;

/** "{category} {lower}–{upper}": ≥ / > from lower_inclusive, ≤ / < from upper_inclusive; the dash is omitted for an open bound (§6.2). */
export function bandText(b: BreakpointBandDto): string {
  const lo = b.lower_value !== undefined ? `${b.lower_inclusive ? '≥' : '>'} ${b.lower_value}` : undefined;
  const hi = b.upper_value !== undefined ? `${b.upper_inclusive ? '≤' : '<'} ${b.upper_value}` : undefined;
  if (lo && hi) return `${b.category_code} ${lo.replace(' ', '')}–${hi.replace(' ', '')}`;
  return `${b.category_code} ${lo ?? hi ?? ''}`.trim();
}

type IssueRow = BreakpointImportIssueDto & { id: string };
const ISSUE_COLUMNS: readonly ColumnDef<IssueRow>[] = [
  { id: 'line', header: 'Line', align: 'end', isRowHeader: true, cell: (i) => (i.line_no === undefined ? '—' : String(i.line_no)) },
  { id: 'severity', header: 'Severity', cell: (i) => <Chip tone={i.severity === 'error' ? 'danger' : 'warning'} label={i.severity === 'error' ? 'Error' : 'Warning'} /> },
  { id: 'code', header: 'Code', cell: (i) => i.code },
  { id: 'field', header: 'Field', cell: (i) => i.field ?? '—' },
  { id: 'message', header: 'Message', cell: (i) => i.message },
];
const ROW_COLUMNS: readonly ColumnDef<BreakpointRowDto>[] = [
  { id: 'line', header: 'Line', align: 'end', isRowHeader: true, cell: (r) => String(r.line_no) },
  { id: 'scope', header: 'Scope', cell: (r) => r.organism_scope },
  { id: 'organism', header: 'Organism/group', cell: (r) => r.organism_code ?? r.organism_group_code ?? '—' },
  { id: 'antibiotic', header: 'Antibiotic', cell: (r) => r.antibiotic_code },
  { id: 'method', header: 'Method', cell: (r) => r.method },
  { id: 'site', header: 'Site', cell: (r) => r.specimen_site_code ?? '—' },
  { id: 'qualifier', header: 'Qualifier', cell: (r) => r.qualifier_code ?? '—' },
  { id: 'bands', header: 'Bands', cell: (r) => [...r.bands].sort((a, b) => a.band_no - b.band_no).map(bandText).join('; ') },
];

type Severity = 'all' | 'error' | 'warning';
type Confirm = 'activate' | 'retire' | 'discard';

export function BreakpointSetDetail({ set, issues: initialIssues, rows: initialRows, permissions }: {
  set: BreakpointSetDto;
  issues: readonly BreakpointImportIssueDto[];
  rows: readonly BreakpointRowDto[];
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const id = set.id;
  const [row, setRow] = useState(set);
  const [issues, setIssues] = useState(initialIssues);
  const [rows, setRows] = useState(initialRows);
  const [tab, setTab] = useState('issues');
  const [severity, setSeverity] = useState<Severity>('all');
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<Confirm>();
  const [startFrom, setStartFrom] = useState<IsoUtc>();
  const [fail, setFail] = useState<Fail>();

  // Poll while uploaded/validating; on the first terminal status load the issues and rows once. A failed poll keeps the page and retries.
  const live = isChecking(row.status);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(async () => {
        try {
          const r = await pollBreakpointSetAction(id);
          if (!alive) return;
          if (r.ok) {
            setRow(r.data);
            if (!isChecking(r.data.status)) {
              const [i, w] = await Promise.all([listBreakpointIssuesAction(id), listBreakpointRowsAction(id)]);
              if (alive && i.ok) setIssues(i.data);
              if (alive && w.ok) setRows(w.data);
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

  const canManage = permissions.includes(PERM.breakpoint);
  const s = row.status;
  const done = (title: string, r: Extract<ActionResult<BreakpointSetDto>, { ok: true }>, leave = false) => {
    setRow(r.data);
    setConfirm(undefined);
    toast.show({ tone: 'success', title });
    if (leave) router.push('/micro/breakpoint-sets');
    else router.refresh();
  };
  const act = async (kind: Confirm) => {
    setFail(undefined);
    const r = kind === 'activate' ? await activateBreakpointSetAction(id, row.version, startFrom) : kind === 'retire' ? await retireBreakpointSetAction(id, row.version) : await discardBreakpointSetAction(id, row.version);
    if (r.ok) done(kind === 'activate' ? 'Table activated' : kind === 'retire' ? 'Table retired' : 'Table discarded', r, kind === 'discard');
    else { setFail(r); setConfirm(undefined); }
  };
  const openActivate = () => {
    const intended = row.intended_effective_from; // default = the intended start while it is still in the future (the API refuses earlier than now − 60 s)
    setStartFrom(intended && Date.parse(intended) > Date.now() ? asIso(intended) : undefined);
    setConfirm('activate');
  };

  const shownIssues: IssueRow[] = issues.filter((i) => severity === 'all' || i.severity === severity).map((i, n) => ({ ...i, id: String(n) }));
  const needle = filter.trim().toLowerCase();
  const shownRows = rows.filter((r) => !needle || [r.antibiotic_code, r.organism_code, r.organism_group_code].some((c) => c?.toLowerCase().includes(needle)));

  return (
    <section aria-label="Breakpoint table">
      <PageHeader
        title={row.title}
        helpKey="micro.breakpoint_sets"
        breadcrumbs={[{ label: 'Breakpoint tables', href: '/micro/breakpoint-sets' }, { label: row.title }]}
        status={<BreakpointStatusChip status={s} />}
        actions={canManage ? (
          <>
            {s === 'validated' ? <Button variant="primary" onPress={openActivate}>Activate</Button> : null}
            {s === 'active' ? <Button onPress={() => setConfirm('retire')}>Retire</Button> : null}
            {s === 'uploaded' || s === 'validated' || s === 'invalid' ? <Button onPress={() => setConfirm('discard')}>Discard</Button> : null}
          </>
        ) : null}
      />
      <FailNotice fail={fail} />
      {live ? (
        <div className="lims-inline">
          <Spinner label="Checking the file" />
          <span>{CHECKING}</span>
        </div>
      ) : null}
      {s === 'invalid' ? <Banner tone="danger" title="The file has errors, so this table cannot be activated. Fix the file and import it again." /> : null}
      <DescriptionList
        columns={2}
        items={[
          { term: 'Standard', value: row.standard },
          { term: 'Version', value: row.standard_version },
          { term: 'Licence confirmation', value: row.licence_attestation_text }, // text node; the kit has no pre-wrap utility class (LD-140 forbids inline styles) — CR candidate
          { term: 'SHA-256', value: <IdText value={row.file_sha256} truncate={64} copyable /> },
          { term: 'File size', value: bytes(row.file_bytes) },
          { term: 'Contents', value: `${row.row_count} rows, ${row.band_count} bands` },
          { term: 'Issues found', value: `${row.error_count} errors, ${row.warning_count} warnings` },
          { term: 'Intended start', value: <When value={row.intended_effective_from} time /> },
          { term: 'Effective from', value: <When value={row.effective_from} time /> },
          { term: 'Effective to', value: <When value={row.effective_to} time /> },
          { term: 'Imported by', value: row.imported_by_display },
          { term: 'Imported at', value: <When value={row.created_at} time /> },
          ...(row.activated_by_display ? [{ term: 'Activated by', value: row.activated_by_display }] : []),
          ...(row.activated_at ? [{ term: 'Activated at', value: <When value={row.activated_at} time /> }] : []),
          ...(row.retired_at ? [{ term: 'Retired at', value: <When value={row.retired_at} time /> }] : []),
        ]}
      />
      <Tabs items={[{ id: 'issues', label: 'Issues', badge: String(row.error_count + row.warning_count) }, { id: 'rows', label: 'Rows', badge: String(row.row_count) }]} selectedId={tab} onChange={setTab} aria-label="Table contents">
        {tab === 'issues' ? (
          <>
            <Select<Severity> label="Severity" name="severity" value={severity} onChange={setSeverity} options={[{ value: 'all', label: 'All' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }]} />
            <DataTable<IssueRow> caption="Import issues" columns={ISSUE_COLUMNS} rows={shownIssues} getRowId={(i) => i.id} emptyState={{ title: 'No issues.' }} />
          </>
        ) : (
          <>
            <TextField label="Filter by antibiotic or organism" name="filter" maxLength={64} value={filter} onChange={setFilter} />
            <DataTable<BreakpointRowDto> caption="Breakpoint rows" columns={ROW_COLUMNS} rows={shownRows} getRowId={(r) => r.id} emptyState={{ title: 'No rows.' }} />
          </>
        )}
      </Tabs>

      <ConfirmDialog
        isOpen={confirm === 'activate'}
        title="Activate table"
        confirmLabel="Activate"
        body={
          <>
            <p>{`The current ${row.standard} table will stop being used from this time.`}</p>
            <DateTimePicker label="Start using from" name="effective_from" description="Leave empty to start now." {...(startFrom ? { value: startFrom } : {})} onChange={setStartFrom} />
          </>
        }
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => act('activate')}
      />
      <ConfirmDialog
        isOpen={confirm === 'retire'}
        title="Retire table"
        tone="danger"
        confirmLabel="Retire"
        body={<p>{`This ${row.standard} table will stop being used. Categories are entered manually until another table is activated.`}</p>}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => act('retire')}
      />
      <ConfirmDialog
        isOpen={confirm === 'discard'}
        title="Discard table"
        tone="danger"
        confirmLabel="Discard"
        body={<p>This table was never used and will be discarded. This cannot be undone.</p>}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => act('discard')}
      />
    </section>
  );
}
