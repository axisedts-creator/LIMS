'use client';
// The actions of a record row (AC-08.4 assign, AC-08.5 apply, AC-08.6 resolve, ignore) shared by the inbox page and the culture tab. LD-140 (2026-11-13): kit components only.
// The screen never decides a record's state: it opens a dialog or posts, the API moves the record, the page refreshes. Apply has no dialog: one POST per press (a press while
// one is running is ignored; the key is new per press because a pressed Apply is a new decision).
import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { useToast } from '@lims/ui/components/Toast';
import { applyInstrumentRecordAction } from '../../server/instrumentRecordActions';
import type { InstrumentRecordDto } from '../../server/types';
import { FailNotice, newKey, type Fail } from '../common';
import { AssignDialog } from './AssignDialog';
import { IgnoreDialog } from './IgnoreDialog';
import { ResolveDialog } from './ResolveDialog';
import type { RecordAction } from './labels';

type Dlg = { k: 'assign' | 'resolve' | 'ignore'; record: InstrumentRecordDto };
const STILL_UNMAPPED = 'This record still needs a code mapping. Ask your lab manager to map the code, then apply it again.';

/** `onDone` runs after every saved change, next to router.refresh() (the culture tab reloads its own list there). */
export function useRecordFlow(onDone?: () => void): { onAction: (r: InstrumentRecordDto, a: RecordAction) => void; ui: ReactNode } {
  const router = useRouter();
  const toast = useToast();
  const [dlg, setDlg] = useState<Dlg>();
  const [fail, setFail] = useState<Fail>();
  const [notice, setNotice] = useState<string>();
  const inflight = useRef(false);

  const done = () => {
    setDlg(undefined);
    router.refresh();
    onDone?.();
  };
  const close = () => setDlg(undefined);

  const apply = async (r: InstrumentRecordDto) => {
    if (inflight.current) return;
    inflight.current = true;
    setFail(undefined);
    setNotice(undefined);
    try {
      const res = await applyInstrumentRecordAction(r.id, r.version, {}, newKey());
      if (!res.ok) {
        setFail(res);
        return;
      }
      if (res.data.match_status === 'conflict') setDlg({ k: 'resolve', record: res.data }); // AC-08.6: never a silent success
      else if (res.data.match_status === 'needs_mapping') {
        setNotice(STILL_UNMAPPED);
        router.refresh();
        onDone?.();
      } else {
        toast.show({ tone: 'success', title: 'Instrument data applied' });
        router.refresh();
        onDone?.();
      }
    } catch {
      setFail({ ok: false, status: 0, code: 'common.internal' });
    } finally {
      inflight.current = false;
    }
  };

  const onAction = (r: InstrumentRecordDto, a: RecordAction) => {
    setFail(undefined);
    setNotice(undefined);
    if (a === 'apply') void apply(r);
    else setDlg({ k: a, record: r });
  };

  const ui = (
    <>
      <FailNotice fail={fail} />
      {notice ? (
        <div role="status">
          <Banner tone="warning" title={notice} />
        </div>
      ) : null}
      {dlg?.k === 'assign' ? (
        <AssignDialog
          record={dlg.record}
          onClose={close}
          onSaved={(saved) => (saved.match_status === 'conflict' ? setDlg({ k: 'resolve', record: saved }) : done())}
        />
      ) : null}
      {dlg?.k === 'resolve' ? <ResolveDialog record={dlg.record} onClose={close} onSaved={done} /> : null}
      {dlg?.k === 'ignore' ? <IgnoreDialog record={dlg.record} onClose={close} onSaved={done} /> : null}
    </>
  );
  return { onAction, ui };
}
