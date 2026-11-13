'use client';
// 04-UI-UX §4.2.3 Blocks & slides tab: Blocks table (select, Add blocks, Add slides, Record movement, Print labels) and Slides table (Add slides from part, Mark ready,
// Record movement, Print labels; Assessment column + Drawer for cytology). People without anatomic.case.work see the values only (no checkboxes, no buttons).
// Selection may exceed 200: writes are split into calls of at most 200 ids (REQ-SEC-100). Server text is rendered as text, never HTML (REQ-SEC-088).
// LD-140 (2026-11-13, binding): kit components only; toolbar buttons are secondary (the page's one primary button is the stage button in the header); statuses show tone, icon and word.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { listAdequacyAction, markSlidesReadyAction } from '../../server/actions.material';
import type { CaseDetail, CodedValue, Slide } from '../../server/types';
import { useToast } from '@lims/ui/components/Toast';
import { Chip, LocationChip, newKey, partName, type Fail } from '../common';
import { MovementDialog, type MovementDone, type MovementItem } from '../tracking/MovementDialog';
import { AddBlocksDialog, AddSlidesDialog, AssessmentDrawer } from './MaterialDialogs';
import { chunk } from './useStains';

const NO_LIMIT = Number.MAX_SAFE_INTEGER; // the kit caps a selection at 200 by default; calls are split instead (see header)
const MAX_IDS_IN_URL = 200;

interface Skipped { label: string; reason: string }
type Dialog = { kind: 'blocks' } | { kind: 'slides'; blockId?: string } | { kind: 'move'; items: MovementItem[] } | { kind: 'assess'; slide: Slide } | undefined;

export function BlocksSlidesTab({ detail, canWork, onFail, onMfa }: { detail: CaseDetail; canWork: boolean; onFail: (f: Fail) => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const cytology = detail.case_kind === 'cytology';
  const [blockSel, setBlockSel] = useState<ReadonlySet<string>>(new Set());
  const [slideSel, setSlideSel] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>();
  const [adequacy, setAdequacy] = useState<readonly CodedValue[]>([]);
  const [result, setResult] = useState<{ ready: number; skipped: Skipped[] }>();
  const [showSkipped, setShowSkipped] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cytology) return;
    let live = true;
    listAdequacyAction().then((r) => live && r.ok && setAdequacy(r.data), () => undefined);
    return () => { live = false; };
  }, [cytology]);

  const blockLabel = (id: string | undefined) => detail.blocks.find((b) => b.id === id)?.label;
  const close = () => setDialog(undefined);
  const done = () => { close(); setBlockSel(new Set()); setSlideSel(new Set()); router.refresh(); };
  const printLabels = (kind: 'blocks' | 'slides', sel: ReadonlySet<string>) => {
    const ids = [...sel];
    router.push(`/anatomic/cases/${detail.id}/labels?kind=${kind}${ids.length > 0 && ids.length <= MAX_IDS_IN_URL ? `&ids=${ids.join(',')}` : ''}`);
  };
  const move = (kind: 'block' | 'slide') =>
    setDialog({ kind: 'move', items: (kind === 'block' ? detail.blocks : detail.slides).filter((x) => (kind === 'block' ? blockSel : slideSel).has(x.id)).map((x) => ({ id: x.id, label: x.label, kind })) });

  const markReady = async () => {
    if (busy) return;
    setBusy(true);
    setResult(undefined);
    try {
      const outcomes = new Map<string, string>();
      for (const ids of chunk([...slideSel])) {
        const r = await markSlidesReadyAction(ids, newKey());
        if (!r.ok) return r.code === 'auth.mfa_required' ? onMfa() : onFail(r);
        for (const o of r.data.results) outcomes.set(o.id, o.outcome);
      }
      const skipped = [...outcomes].filter(([, o]) => o !== 'updated').map(([id, o]) => ({ label: detail.slides.find((s) => s.id === id)?.label ?? 'Slide', reason: o === 'invalid_state' ? 'Already ready or not in a state that can be marked ready' : 'Not found' }));
      setResult({ ready: outcomes.size - skipped.length, skipped });
      setSlideSel(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const moved = ({ recorded, failed }: MovementDone) => {
    done();
    if (recorded) toast.show({ tone: 'success', title: `${recorded} recorded` });
    if (failed.length) toast.show({ tone: 'warning', title: `${failed.length} not recorded`, description: failed.map((f) => `${f.label}: that step isn't possible in its current state`).join('; ') });
  };

  const oneBlock = blockSel.size === 1 ? [...blockSel][0] : undefined;
  return (
    <>
      <section aria-labelledby="blocks-title">
        <h2 id="blocks-title" className="lims-card-title">Blocks</h2>
        {canWork ? (
          <div role="toolbar" aria-label="Block actions">
            <Button onPress={() => setDialog({ kind: 'blocks' })}>Add blocks</Button>
            <Button isDisabled={!oneBlock} onPress={() => setDialog({ kind: 'slides', ...(oneBlock ? { blockId: oneBlock } : {}) })}>Add slides</Button>
            <Button isDisabled={blockSel.size === 0} onPress={() => move('block')}>Record movement</Button>
            <Button onPress={() => printLabels('blocks', blockSel)}>Print labels</Button>
          </div>
        ) : null}
        <DataTable
          caption="Blocks"
          density="compact"
          rows={detail.blocks}
          getRowId={(b) => b.id}
          emptyState={{ title: 'No blocks yet. Add blocks after grossing.' }}
          {...(canWork ? { selection: { mode: 'multiple' as const, selectedIds: blockSel, onChange: setBlockSel, max: NO_LIMIT } } : {})}
          columns={[
            { id: 'label', header: 'Label', isRowHeader: true, cell: (b) => <><span className="lims-mono">{b.label}</span>{' '}</> },
            { id: 'part', header: 'Part', cell: (b) => partName(detail.parts, b.part_id) },
            { id: 'slides', header: 'Slides', align: 'end', cell: (b) => b.slide_count },
            { id: 'loc', header: 'Location', cell: (b) => <LocationChip status={b.location_status} text={b.location_text} /> },
            { id: 'note', header: 'Note', cell: (b) => b.note ?? '—' },
          ]}
        />
      </section>

      <section aria-labelledby="slides-title">
        <h2 id="slides-title" className="lims-card-title">Slides</h2>
        {canWork ? (
          <div role="toolbar" aria-label="Slide actions">
            {cytology || detail.blocks.length === 0 ? <Button onPress={() => setDialog({ kind: 'slides' })}>Add slides from part</Button> : null}
            <Button isDisabled={slideSel.size === 0 || busy} onPress={() => void markReady()}>Mark ready</Button>
            <Button isDisabled={slideSel.size === 0} onPress={() => move('slide')}>Record movement</Button>
            <Button onPress={() => printLabels('slides', slideSel)}>Print labels</Button>
          </div>
        ) : null}
        {result ? (
          <div role="status">
            <Banner
              tone={result.skipped.length ? 'warning' : 'success'}
              title={`${result.ready} ${result.ready === 1 ? 'slide' : 'slides'} marked ready, ${result.skipped.length} skipped`}
              {...(result.skipped.length ? { action: { label: 'View skipped slides', onPress: () => setShowSkipped(true) } } : {})}
            />
          </div>
        ) : null}
        <DataTable
          caption="Slides"
          density="compact"
          rows={detail.slides}
          getRowId={(s) => s.id}
          emptyState={{ title: 'No slides yet.' }}
          {...(canWork ? { selection: { mode: 'multiple' as const, selectedIds: slideSel, onChange: setSlideSel, max: NO_LIMIT } } : {})}
          columns={[
            { id: 'label', header: 'Label', isRowHeader: true, cell: (s) => <><span className="lims-mono">{s.label}</span>{' '}</> },
            { id: 'source', header: 'Source', cell: (s) => (s.block_id ? (blockLabel(s.block_id) ?? '—') : partName(detail.parts, s.part_id)) },
            { id: 'stain', header: 'Stain', cell: (s) => s.stain_display },
            { id: 'status', header: 'Status', cell: (s) => (s.status === 'ready' ? <Chip size="sm" tone="success" label="Ready" /> : <Chip size="sm" tone="warning" label="Pending stain" />) },
            { id: 'loc', header: 'Location', cell: (s) => <LocationChip status={s.location_status} text={s.location_text} /> },
            ...(cytology
              ? [{
                  id: 'assessment',
                  header: 'Assessment',
                  cell: (s: Slide) => (
                    <>
                      <span>{adequacy.find((a) => a.code === s.adequacy_code)?.display ?? s.adequacy_code ?? '—'}</span>
                      {s.include_in_report ? <> <Chip size="sm" tone="info" label="In report" /></> : null}
                      {canWork ? <> <Button size="sm" onPress={() => setDialog({ kind: 'assess', slide: s })}>Assess</Button></> : null}
                    </>
                  ),
                }]
              : []),
          ]}
        />
      </section>

      {dialog?.kind === 'blocks' ? <AddBlocksDialog detail={detail} onClose={close} onMfa={onMfa} onDone={done} /> : null}
      {dialog?.kind === 'slides' ? <AddSlidesDialog detail={detail} {...(dialog.blockId ? { blockId: dialog.blockId } : {})} onClose={close} onMfa={onMfa} onDone={done} /> : null}
      {dialog?.kind === 'assess' ? <AssessmentDrawer key={dialog.slide.id} detail={detail} slide={dialog.slide} adequacy={adequacy} onClose={close} onMfa={onMfa} onDone={done} /> : null}
      <MovementDialog
        items={dialog?.kind === 'move' ? dialog.items : []}
        isOpen={dialog?.kind === 'move'}
        onClose={close}
        onMfa={() => { close(); onMfa(); }}
        onDone={moved}
      />
      <Drawer title="Skipped slides" isOpen={showSkipped} onClose={() => setShowSkipped(false)}>
        <ul>
          {(result?.skipped ?? []).map((s, i) => <li key={i}><span className="lims-mono">{s.label}</span> — {s.reason}</li>)}
        </ul>
      </Drawer>
    </>
  );
}
