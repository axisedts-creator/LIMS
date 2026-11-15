'use client';
// 04-UI-UX §4 "Ignore" (03-APP-FLOW §2.4 IR6; M22): kit ConfirmDialog with a required reason from the coded set micro.record_ignore_reasons (active codes only) and an optional
// comment up to 300 characters. LD-140 (2026-11-13): kit components only. If-Match = record.version; a refusal keeps the dialog open with the choice kept. The ConfirmDialog
// blocks a second click while the request runs.
import { useState } from 'react';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { useCodes } from '../../forms/useCodes';
import { ignoreInstrumentRecordAction } from '../../server/instrumentRecordActions';
import type { InstrumentRecordDto } from '../../server/types';
import { FailNotice, type Fail } from '../common';

export function IgnoreDialog({ record, onClose, onSaved }: { record: InstrumentRecordDto; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const reasons = useCodes('record_ignore_reasons');
  const [fail, setFail] = useState<Fail>();
  if (!reasons.loaded) return null;

  return (
    <ConfirmDialog
      title="Ignore this record?"
      tone="danger"
      confirmLabel="Ignore"
      isOpen
      body={
        <>
          <FailNotice fail={fail} />
          <p>The record stays in the list as ignored and is not added to any culture.</p>
        </>
      }
      requireReason={{ codedSet: 'micro.record_ignore_reasons', options: reasons.rows.filter((r) => r.is_active).map((r) => ({ code: r.code, display: r.display })), freeText: { maxLength: 300, isRequired: false } }}
      onCancel={onClose}
      onConfirm={async ({ reasonCode, reasonText }) => {
        if (!reasonCode) return;
        setFail(undefined);
        let r;
        try {
          r = await ignoreInstrumentRecordAction(record.id, record.version, { reason_code: reasonCode, ...(reasonText?.trim() ? { comment: reasonText.trim() } : {}) });
        } catch {
          setFail({ ok: false, status: 0, code: 'common.internal' });
          return;
        }
        if (!r.ok) {
          setFail(r);
          return;
        }
        toast.show({ tone: 'success', title: 'Record ignored' });
        onSaved();
      }}
    />
  );
}
