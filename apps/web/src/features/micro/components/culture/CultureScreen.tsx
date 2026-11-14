'use client';
// 04-UI-UX §3 Culture screen: PageHeader (title = test name, breadcrumbs, status chip, actions per state) → identity card → banners → Tabs → dialogs.
// AC-03.* / AC-04.* / AC-05.* UI side. LD-140 (2026-11-13): kit components only (no hex colours, pixel radii or inline style objects); one primary button per page;
// every status shows tone, icon and word. The screen never decides culture state: it opens dialogs, the dialogs post, the server moves the culture and the page refreshes.
// Buttons that the state or the permission does not allow are not rendered (03-APP-FLOW §4.2). Page shortcuts are registered once under 'micro.culture' (04-UI-UX §3).
// T-22: Preliminary / Final report open the report drawer (Alt+P / Alt+F), "Reopen for amendment" its dialog, and the Reports tab lists the versions (components/reports).
// Cancel stays disabled here (its own task). T-21: the AST grid and "Choose AST panel" live in the Isolates & AST tab;
// leaving that tab with unsaved AST values asks "Discard unsaved AST changes?" (03-APP-FLOW §6); Alt+A focuses the grid of the selected isolate.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { shortcuts } from '@/core/shortcuts/registry';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
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
import { AssignPanelDialog } from '../ast/AssignPanelDialog';
import { AstPane, showsGrid } from '../ast/AstPane';
import { focusFirstAstInput } from '../ast/AstGrid';
import { useTenantStandard } from '../ast/useTenantStandard';
import { ReopenDialog } from '../reports/ReopenDialog';
import { ReportDrawer } from '../reports/ReportDrawer';
import { ReportsTab } from '../reports/ReportsTab';
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
  | { k: 'panel'; isolate: IsolateDto }
  | { k: 'report'; phase: 'preliminary' | 'final' }
  | { k: 'reopen' }
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
  const [astDirty, setAstDirty] = useState(false);
  const [leaving, setLeaving] = useState<string>(); // the tab the user wants while the AST grid has unsaved values
  const [, setFocusTick] = useState(0);
  const router = useRouter();
  const root = useRef<HTMLElement>(null);
  const focusAst = useRef(false);
  const can = (k: keyof typeof ALLOWED) => permissions.includes(WORK) && (ALLOWED[k] as readonly string[]).includes(culture.status);
  const selectedIsolate = culture.isolates.find((i) => i.id === selected);
  const tenant = useTenantStandard(tab === 'isolates' && showsGrid(selectedIsolate));
  const goTab = (id: string) => (tab === 'isolates' && id !== 'isolates' && astDirty ? setLeaving(id) : setTab(id));

  // Alt+A: open the tab, then focus the first Raw value of the selected isolate's grid (the grid itself takes the request when it is still loading).
  useEffect(() => {
    if (!focusAst.current || tab !== 'isolates') return;
    if (focusFirstAstInput(root.current) || !showsGrid(selectedIsolate)) focusAst.current = false;
  });

  // Shortcuts call the latest handlers (state and permissions change after registration).
  const act = useRef<Record<string, () => void>>({});
  act.current = {
    setup: () => can('setup') && setDlg({ k: 'setup' }),
    read: () => can('read') && setDlg({ k: 'obs', kind: 'plate_read' }),
    gram: () => can('stain') && setDlg({ k: 'obs', kind: 'gram_stain' }),
    isolate: () => can('isolate') && setDlg({ k: 'isolate', mode: { kind: 'add' } }),
    ast: () => { focusAst.current = true; setTab('isolates'); setFocusTick((n) => n + 1); },
    prelim: () => can('prelim') && setDlg({ k: 'report', phase: 'preliminary' }),
    final: () => can('final') && setDlg({ k: 'report', phase: 'final' }),
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
        { key: 'Alt+P', description: 'Preliminary report', run: () => act.current['prelim']!() },
        { key: 'Alt+F', description: 'Final report', run: () => act.current['final']!() },
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
      {action('prelim', 'Preliminary report', () => setDlg({ k: 'report', phase: 'preliminary' }))}
      {action('final', 'Final report', () => setDlg({ k: 'report', phase: 'final' }))}
      {action('cancel', 'Cancel culture')}
      {action('reopen', 'Reopen for amendment', () => setDlg({ k: 'reopen' }))}
    </Inline>
  );

  const onIsolate = (i: IsolateDto, a: IsolateAction) => {
    if (a === 'identify') setDlg({ k: 'isolate', mode: { kind: 'identify', isolate: i } });
    else if (a === 'describe') setDlg({ k: 'isolate', mode: { kind: 'describe', isolate: i } });
    else if (a === 'withdraw') setDlg({ k: 'withdraw', isolate: i });
    else setDlg({ k: 'panel', isolate: i });
  };

  return (
    <section aria-label="Culture" ref={root}>
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
          onChange={goTab}
        >
          {tab === 'setup' ? <SetupPlatesTab culture={culture} canDiscard={can('plate')} onDiscard={(p) => setDlg({ k: 'discard', plate: p })} /> : null}
          {tab === 'reads' ? <ReadsTab culture={culture} canCorrect={can('stain')} onCorrect={(o) => setDlg({ k: 'obs', kind: o.kind, correcting: o })} /> : null}
          {tab === 'isolates' ? (
            <IsolatesTab
              culture={culture}
              canWork={can('isolate')}
              selectedId={selected}
              onSelect={setSelected}
              onAction={onIsolate}
              pane={<AstPane isolate={selectedIsolate} canWork={can('isolate')} tenant={tenant} focusRequest={focusAst} onChoosePanel={(i) => setDlg({ k: 'panel', isolate: i })} onSaved={() => router.refresh()} onDirtyChange={setAstDirty} />}
            />
          ) : null}
          {tab === 'reports' ? <ReportsTab culture={culture} /> : null}
          {tab === 'instrument' ? <EmptyState title="No instrument data to show here yet." /> : null}
        </Tabs>
      </Stack>
      {dlg?.k === 'setup' ? <SetupCultureDialog culture={culture} onClose={close} /> : null}
      {dlg?.k === 'plate' ? <AddPlateDialog culture={culture} onClose={close} /> : null}
      {dlg?.k === 'obs' ? <ObservationDialog culture={culture} kind={dlg.kind} {...(dlg.correcting ? { correcting: dlg.correcting } : {})} onClose={close} /> : null}
      {dlg?.k === 'isolate' ? <IsolateDialog culture={culture} mode={dlg.mode} onClose={close} /> : null}
      {dlg?.k === 'discard' ? <DiscardPlateDialog cultureId={culture.id} plate={dlg.plate} onClose={close} /> : null}
      {dlg?.k === 'withdraw' ? <WithdrawIsolateDialog isolate={dlg.isolate} onClose={close} /> : null}
      {dlg?.k === 'panel' ? <AssignPanelDialog isolate={dlg.isolate} onClose={close} /> : null}
      {dlg?.k === 'report' ? <ReportDrawer culture={culture} phase={dlg.phase} onClose={close} onSent={() => setTab('reports')} /> : null}
      {dlg?.k === 'reopen' ? <ReopenDialog culture={culture} onClose={close} /> : null}
      {dlg?.k === 'scan' ? <ScanDialog currentCultureId={culture.id} onClose={close} /> : null}
      {leaving ? (
        <ConfirmDialog
          title="Discard unsaved AST changes?"
          confirmLabel="Discard"
          isOpen
          body={<p>The values typed in the AST grid have not been saved.</p>}
          onCancel={() => setLeaving(undefined)}
          onConfirm={() => {
            setAstDirty(false);
            setSelected(undefined); // the grid is gone; a later selection starts from the stored values
            setTab(leaving);
            setLeaving(undefined);
          }}
        />
      ) : null}
    </section>
  );
}
