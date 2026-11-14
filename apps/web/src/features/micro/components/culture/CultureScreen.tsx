'use client';
// 04-UI-UX §3 Culture screen: PageHeader (title = test name, breadcrumbs, status chip, actions per state) → identity card → banners → Tabs → dialogs.
// AC-03.* / AC-04.* / AC-05.* UI side. LD-140 (2026-11-13): kit components only (no hex colours, pixel radii or inline style objects); one primary button per page;
// every status shows tone, icon and word. The screen never decides culture state: it opens dialogs, the dialogs post, the server moves the culture and the page refreshes.
// Buttons that the state or the permission does not allow are not rendered (03-APP-FLOW §4.2). Page shortcuts are registered once under 'micro.culture' (04-UI-UX §3).
// Preliminary / Final report, Cancel and Reopen are wired by T-22 (their buttons exist here, disabled); the AST grid and "Choose AST panel" are T-21.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shortcuts } from '@/core/shortcuts/registry';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Tabs } from '@lims/ui/components/Tabs';
import { AddPlateDialog } from '../../forms/AddPlateDialog';
import { DiscardPlateDialog } from '../../forms/DiscardPlateDialog';
import { IsolateDialog, type IsolateMode } from '../../forms/IsolateDialog';
import { ObservationDialog } from '../../forms/ObservationDialog';
import { ScanDialog } from '../../forms/ScanDialog';
import { SetupCultureDialog } from '../../forms/SetupCultureDialog';
import { WithdrawIsolateDialog } from '../../forms/WithdrawIsolateDialog';
import type { CultureDetailDto, IsolateDto, ObservationDto, ObservationKind, PatientLite, PlateDto, SpecimenLite } from '../../server/types';
import { CultureStatusChip } from '../worklist/CultureStatusChip';
import { IdentityCard } from './IdentityCard';
import { IsolatesTab, type IsolateAction } from './IsolatesTab';
import { ReadsTab } from './ReadsTab';
import { SetupPlatesTab } from './SetupPlatesTab';

const WORK = 'micro.culture.work';
const READING = ['incubating', 'growth_detected', 'amending'];

type Dlg =
  | { k: 'setup' }
  | { k: 'plate' }
  | { k: 'obs'; kind: ObservationKind; correcting?: ObservationDto }
  | { k: 'isolate'; mode: IsolateMode }
  | { k: 'discard'; plate: PlateDto }
  | { k: 'withdraw'; isolate: IsolateDto }
  | { k: 'scan' };

/** What each button needs (03-APP-FLOW §4.2). */
const ALLOWED = {
  setup: ['awaiting_setup'],
  read: READING,
  stain: ['awaiting_setup', ...READING],
  plate: READING,
  isolate: READING,
  prelim: ['incubating', 'growth_detected'],
  final: READING,
  cancel: ['awaiting_setup', 'incubating', 'growth_detected'],
  reopen: ['final_submitted'],
} as const;

export interface CultureScreenProps {
  culture: CultureDetailDto;
  /** null = the patient read failed or was refused. */
  patient: PatientLite | null;
  specimen?: SpecimenLite | null;
  permissions: readonly string[];
}

export function CultureScreen({ culture, patient, specimen, permissions }: CultureScreenProps) {
  const [tab, setTab] = useState('setup');
  const [dlg, setDlg] = useState<Dlg>();
  const [selected, setSelected] = useState<string>();
  const can = (k: keyof typeof ALLOWED) => permissions.includes(WORK) && (ALLOWED[k] as readonly string[]).includes(culture.status);

  // Shortcuts call the latest handlers (state and permissions change after registration).
  const act = useRef<Record<string, () => void>>({});
  act.current = {
    setup: () => can('setup') && setDlg({ k: 'setup' }),
    read: () => can('read') && setDlg({ k: 'obs', kind: 'plate_read' }),
    gram: () => can('stain') && setDlg({ k: 'obs', kind: 'gram_stain' }),
    isolate: () => can('isolate') && setDlg({ k: 'isolate', mode: { kind: 'add' } }),
    ast: () => setTab('isolates'),
    reports: () => setTab('reports'),
    scan: () => setDlg({ k: 'scan' }),
  };
  useEffect(
    () =>
      shortcuts.register(
        'micro.culture', // 04-UI-UX §3
        { key: 'Alt+S', description: 'Set up culture', run: () => act.current['setup']!() },
        { key: 'Alt+R', description: 'Record read', run: () => act.current['read']!() },
        { key: 'Alt+G', description: 'Record Gram stain', run: () => act.current['gram']!() },
        { key: 'Alt+I', description: 'Add isolate', run: () => act.current['isolate']!() },
        { key: 'Alt+A', description: 'Focus the AST grid of the selected isolate', run: () => act.current['ast']!() },
        { key: 'Alt+P', description: 'Preliminary report', run: () => act.current['reports']!() },
        { key: 'Alt+F', description: 'Final report', run: () => act.current['reports']!() },
        { key: 'Alt+B', description: 'Scan a specimen barcode', run: () => act.current['scan']!() },
      ),
    [],
  );

  const close = () => setDlg(undefined);
  const primary = (k: keyof typeof ALLOWED): 'primary' | 'secondary' => ((culture.status === 'awaiting_setup' ? k === 'setup' : culture.status === 'final_submitted' ? k === 'reopen' : k === 'read') ? 'primary' : 'secondary');
  const action = (k: keyof typeof ALLOWED, label: string, run?: () => void) =>
    can(k) ? (
      <Button key={k} variant={primary(k)} {...(run ? { onPress: run } : { isDisabled: true })}>
        {label}
      </Button>
    ) : null;

  const actions: ReactNode = (
    <Inline gap={2}>
      {action('setup', 'Set up culture', () => setDlg({ k: 'setup' }))}
      {action('read', 'Record read', () => setDlg({ k: 'obs', kind: 'plate_read' }))}
      {action('stain', 'Record stain / microscopy', () => setDlg({ k: 'obs', kind: 'gram_stain' }))}
      {action('plate', 'Add plate', () => setDlg({ k: 'plate' }))}
      {action('isolate', 'Add isolate', () => setDlg({ k: 'isolate', mode: { kind: 'add' } }))}
      {action('prelim', 'Preliminary report')}
      {action('final', 'Final report')}
      {action('cancel', 'Cancel culture')}
      {action('reopen', 'Reopen for amendment')}
    </Inline>
  );

  const onIsolate = (i: IsolateDto, a: IsolateAction) => {
    if (a === 'identify') setDlg({ k: 'isolate', mode: { kind: 'identify', isolate: i } });
    else if (a === 'describe') setDlg({ k: 'isolate', mode: { kind: 'describe', isolate: i } });
    else if (a === 'withdraw') setDlg({ k: 'withdraw', isolate: i });
    else {
      setSelected(i.id); // T-21 shows the panel chooser / AST grid of the selected isolate
    }
  };

  return (
    <section aria-label="Culture">
      <Stack gap={3}>
        <PageHeader
          title={culture.test_name}
          breadcrumbs={[{ label: 'Microbiology', href: '/micro/worklist' }, { label: 'Culture' }]}
          status={<CultureStatusChip status={culture.status} />}
          actions={actions}
          helpKey="micro.culture"
        />
        <IdentityCard culture={culture} patient={patient} specimen={specimen} />
        {culture.chain_cancelled ? <Banner tone="warning" title="This test was cancelled in the lab after a report was submitted." /> : null}
        {culture.status === 'amending' ? <Banner tone="warning" title={`Amendment in progress: ${culture.amendment_reason_text ?? ''}`.trim()} /> : null}
        <Tabs
          aria-label="Culture sections"
          items={[
            { id: 'setup', label: 'Setup & plates' },
            { id: 'reads', label: 'Reads & stains' },
            { id: 'isolates', label: 'Isolates & AST' },
            { id: 'reports', label: 'Reports' },
            { id: 'instrument', label: culture.open_instrument_record_count > 0 ? `Instrument data (${culture.open_instrument_record_count})` : 'Instrument data' },
          ]}
          selectedId={tab}
          onChange={setTab}
        >
          {tab === 'setup' ? <SetupPlatesTab culture={culture} canDiscard={can('plate')} onDiscard={(p) => setDlg({ k: 'discard', plate: p })} /> : null}
          {tab === 'reads' ? <ReadsTab culture={culture} canCorrect={can('stain')} onCorrect={(o) => setDlg({ k: 'obs', kind: o.kind, correcting: o })} /> : null}
          {tab === 'isolates' ? <IsolatesTab culture={culture} canWork={can('isolate')} selectedId={selected} onSelect={setSelected} onAction={onIsolate} /> : null}
          {tab === 'reports' ? <EmptyState title="No reports to show here yet." /> : null}
          {tab === 'instrument' ? <EmptyState title="No instrument data to show here yet." /> : null}
        </Tabs>
      </Stack>
      {dlg?.k === 'setup' ? <SetupCultureDialog culture={culture} onClose={close} /> : null}
      {dlg?.k === 'plate' ? <AddPlateDialog culture={culture} onClose={close} /> : null}
      {dlg?.k === 'obs' ? <ObservationDialog culture={culture} kind={dlg.kind} {...(dlg.correcting ? { correcting: dlg.correcting } : {})} onClose={close} /> : null}
      {dlg?.k === 'isolate' ? <IsolateDialog culture={culture} mode={dlg.mode} onClose={close} /> : null}
      {dlg?.k === 'discard' ? <DiscardPlateDialog cultureId={culture.id} plate={dlg.plate} onClose={close} /> : null}
      {dlg?.k === 'withdraw' ? <WithdrawIsolateDialog isolate={dlg.isolate} onClose={close} /> : null}
      {dlg?.k === 'scan' ? <ScanDialog currentCultureId={culture.id} onClose={close} /> : null}
    </section>
  );
}
