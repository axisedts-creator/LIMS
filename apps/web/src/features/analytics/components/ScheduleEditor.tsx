'use client';
// S6 schedule editor (04-UI-UX §8): create + edit. Server rules are mirrored (name, 1-10 reports, 1-20 recipients, <= 20 centres) but the API stays the authority.
// Create sends an Idempotency-Key (one per distinct body, reused on a retry of the same body); edit sends If-Match "<version>" and never retries a 409.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { createScheduleAction, updateScheduleAction } from '../server/actions';
import type { ScheduleInput } from '../server/schedules.server';
import { FREQUENCIES, NAME_INVALID, PERIODS, TIMES, WEEKDAYS, nameIsValid } from '../schedule-labels';

export interface EditorInit {
  name: string; reportCodes: string[]; frequency: string; weekday: number; time: string; period: string; allCentres: boolean; centreIds: string[]; recipientIds: string[];
}
export interface RunVM { id: string; createdAt: string; periodAd: string; periodBs: string }
type Person = { id: string; name: string };

const MAX_REPORTS = 10;
const MAX_RECIPIENTS = 20;
const MAX_CENTRES = 20;
const CONFLICT = 'This schedule was changed by someone else. Your edits are still here. Reload to see the latest version.';

export function ScheduleEditor({ init, reports, recipients, centres, id, version, runs }: {
  init: EditorInit; reports: { code: string; label: string }[]; recipients: Person[]; centres: { id: string; label: string }[]; id?: string; version?: number; runs?: RunVM[];
}) {
  const router = useRouter();
  const [name, setName] = useState(init.name);
  const [codes, setCodes] = useState<string[]>(init.reportCodes);
  const [frequency, setFrequency] = useState(init.frequency);
  const [weekday, setWeekday] = useState(String(init.weekday));
  const [time, setTime] = useState(init.time);
  const [period, setPeriod] = useState(init.period);
  const [allCentres, setAllCentres] = useState(init.allCentres);
  const [centreIds, setCentreIds] = useState<string[]>(init.centreIds);
  const [people, setPeople] = useState<string[]>(init.recipientIds);
  const [errors, setErrors] = useState<{ name?: string | undefined; reports?: string | undefined; recipients?: string | undefined; centres?: string | undefined }>({});
  const [failure, setFailure] = useState<{ text: string; conflict?: boolean }>();
  const attempt = useRef<{ body: string; key: string }>(null);

  const nameOf = (pid: string) => recipients.find((r) => r.id === pid)?.name ?? 'Unavailable recipient';
  const toggle = <T,>(list: T[], v: T, on: boolean, max: number) => (on ? (list.includes(v) || list.length >= max ? list : [...list, v]) : list.filter((x) => x !== v));

  const submit = async () => {
    const e: typeof errors = {};
    if (!nameIsValid(name)) e.name = NAME_INVALID;
    if (codes.length < 1) e.reports = 'Choose at least one report.';
    if (people.length < 1) e.recipients = 'Add at least one recipient.';
    if (!allCentres && centreIds.length < 1) e.centres = 'Choose at least one centre.';
    setErrors(e);
    setFailure(undefined);
    if (Object.keys(e).length > 0) return;

    const input: ScheduleInput = {
      name: name.trim(),
      report_codes: reports.map((r) => r.code).filter((c) => codes.includes(c)), // canonical order
      frequency, send_time_local: time, period_rule: period,
      ...(frequency === 'weekly' ? { weekday: Number(weekday) } : {}),
      scope: allCentres ? { all_centres: true } : { all_centres: false, centre_ids: centreIds },
      recipient_membership_ids: people,
    };
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    const r = id !== undefined && version !== undefined ? await updateScheduleAction(id, version, input) : await createScheduleAction(input, attempt.current.key);
    if (r.ok) { router.push('/analytics/schedules'); return; }
    if (r.code === 'common.version_conflict') setFailure({ text: CONFLICT, conflict: true });
    else if (r.code === 'analytics.recipient_ineligible') {
      const names = (r.paths ?? []).map((p) => /^\/recipient_membership_ids\/(\d+)$/.exec(p)?.[1]).filter((i): i is string => i !== undefined).map((i) => people[Number(i)]).filter((x): x is string => !!x).map(nameOf);
      setFailure({ text: names.length ? names.map((n) => `${n} cannot receive this report`).join('. ') : 'A recipient cannot receive this report. Remove them and try again.' });
    } else if (r.status === 404) setFailure({ text: 'This schedule no longer exists.' });
    else setFailure({ text: 'The schedule could not be saved. Check the fields and try again.' });
  };

  const runCols: ColumnDef<RunVM>[] = [
    { id: 'slot', header: 'Slot time', isRowHeader: true, cell: (r) => <DateText value={r.createdAt as DateTextProps['value']} withTime /> },
    { id: 'period', header: 'Period', cell: (r) => `${r.periodAd}${r.periodBs ? ` · ${r.periodBs} B.S.` : ''}` },
    { id: 'open', header: 'Report', cell: (r) => <a href={`/analytics/report-runs/${r.id}`}>Open</a> },
  ];
  const left = recipients.filter((r) => !people.includes(r.id));

  // Ctrl+Enter submits from anywhere on the page (the button advertises it; native implicit submit only works from a text input).
  const formBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      const form = formBox.current?.querySelector('form');
      if (!form) return;
      e.preventDefault();
      form.requestSubmit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <PageHeader title={id ? 'Edit scheduled report' : 'New scheduled report'} helpKey="analytics.schedules" breadcrumbs={[{ label: 'Scheduled reports', href: '/analytics/schedules' }, { label: id ? 'Edit' : 'New' }]} />
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={failure.text} {...(failure.conflict ? { action: { label: 'Reload latest version', onPress: () => router.refresh() } } : {})} />
        </div>
      ) : null}
      <div ref={formBox}>
      <Form onSubmit={submit}>
        <TextField label="Name" name="name" maxLength={80} isRequired value={name} onChange={(v) => { setName(v); setErrors((x) => ({ ...x, name: undefined })); }} {...(errors.name ? { error: errors.name } : {})} />

        <fieldset className="lims-field">
          <legend className="lims-label">Reports</legend>
          {reports.map((r) => (
            <Checkbox
              key={r.code} label={r.label} isSelected={codes.includes(r.code)}
              isDisabled={!codes.includes(r.code) && codes.length >= MAX_REPORTS}
              onChange={(on) => setCodes((c) => toggle(c, r.code, on, MAX_REPORTS))}
            />
          ))}
          {errors.reports ? <p role="alert" className="lims-error">{errors.reports}</p> : null}
        </fieldset>

        <RadioGroup<string> label="Frequency" name="frequency" value={frequency} options={FREQUENCIES} orientation="horizontal" onChange={setFrequency} />
        {frequency === 'weekly' ? <Select<string> label="Weekday" name="weekday" value={weekday} options={WEEKDAYS} onChange={setWeekday} /> : null}
        <Select<string> label="Send time (Nepal time)" name="send_time_local" value={time} options={TIMES} onChange={setTime} />
        <Select<string> label="Period" name="period_rule" value={period} options={PERIODS} onChange={setPeriod} />

        <RadioGroup<string>
          label="Centres" name="centres" value={allCentres ? 'all' : 'selected'} orientation="horizontal"
          options={[{ value: 'all', label: 'All centres' }, { value: 'selected', label: 'Selected centres' }]} onChange={(v) => setAllCentres(v === 'all')}
        />
        {!allCentres ? (
          <fieldset className="lims-field">
            <legend className="lims-label">Choose centres</legend>
            {centres.map((c) => (
              <Checkbox key={c.id} label={c.label} isSelected={centreIds.includes(c.id)} isDisabled={!centreIds.includes(c.id) && centreIds.length >= MAX_CENTRES} onChange={(on) => setCentreIds((l) => toggle(l, c.id, on, MAX_CENTRES))} />
            ))}
            {errors.centres ? <p role="alert" className="lims-error">{errors.centres}</p> : null}
          </fieldset>
        ) : null}

        <div className="lims-field">
          <Combobox<Person>
            key={people.length} label="Recipients" name="recipients" minChars={1}
            loadOptions={async (q) => left.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 20)}
            getKey={(r) => r.id} renderValue={(r) => r.name} renderOption={(r) => r.name}
            onChange={(r) => { if (r) setPeople((l) => toggle(l, r.id, true, MAX_RECIPIENTS)); setErrors((x) => ({ ...x, recipients: undefined })); }}
          />
          <ul className="lims-inline" aria-label="Chosen recipients">
            {people.map((pid) => (
              <li key={pid}>
                <span>{nameOf(pid)}</span>
                <Button size="sm" variant="ghost" onPress={() => setPeople((l) => l.filter((x) => x !== pid))}>{`Remove ${nameOf(pid)}`}</Button>
              </li>
            ))}
          </ul>
          {errors.recipients ? <p role="alert" className="lims-error">{errors.recipients}</p> : null}
        </div>

        <p className="lims-description">Recipients get an email with a link only. They must sign in to see the figures.</p>
        <div className="lims-inline">
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter">{id ? 'Save changes' : 'Create schedule'}</Button>
          <Button variant="ghost" onPress={() => router.push('/analytics/schedules')}>Cancel</Button>
        </div>
      </Form>
      </div>

      {runs ? (
        <DataTable<RunVM>
          columns={runCols} rows={runs.slice(0, 20)} getRowId={(r) => r.id} density="compact" caption="Run log"
          emptyState={{ title: 'No runs yet', body: 'Each time this schedule fires, the run appears here.' }}
        />
      ) : null}
    </>
  );
}
