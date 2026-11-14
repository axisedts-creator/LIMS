'use client';
// 04-UI-UX §3.2 tab "Reads & stains": observations, newest first. Each entry: "{kind} · plate {n} · {growth} · {quantity}", the finding, who, when and "{h} h after planting".
// A corrected entry is struck through with a "Corrected" badge (AC-04.4); "Correct" opens the dialog for a NEW observation (nothing is edited in place).
// LD-140 (2026-11-13): kit components only. Findings are text nodes with their line breaks kept (REQ-SEC-088).
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { KIND_LABEL } from '../../forms/ObservationDialog';
import { displayOf } from '../../forms/format';
import { useCodes } from '../../forms/useCodes';
import type { CultureDetailDto, ObservationDto } from '../../server/types';
import { Chip, When } from '../common';
import './culture.css';

const hours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

export function ReadsTab({ culture, canCorrect, onCorrect }: { culture: CultureDetailDto; canCorrect: boolean; onCorrect: (o: ObservationDto) => void }) {
  const growth = useCodes('growth_codes', culture.observations.some((o) => o.growth_code));
  if (culture.observations.length === 0) return <EmptyState title="No reads or stains recorded yet." />;
  const list = [...culture.observations].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  const plateNo = (id: string | undefined) => (id ? culture.plates.find((p) => p.id === id)?.plate_no : undefined);
  const summary = (o: ObservationDto) =>
    [KIND_LABEL[o.kind] ?? o.kind, plateNo(o.plate_id) !== undefined ? `plate ${plateNo(o.plate_id)}` : undefined, displayOf(growth.rows, o.growth_code), o.quantity_text].filter(Boolean).join(' · ');
  return (
    <ol className="lims-timeline" aria-label="Reads and stains">
      {list.map((o) => {
        const body = (
          <>
            {summary(o)}
            {o.finding_text ? <span className="lims-finding">{o.finding_text}</span> : null}
          </>
        );
        return (
          <li key={o.id} className="lims-timeline-item" data-tone="neutral">
            {o.is_corrected ? <s>{body}</s> : body}{' '}
            {o.is_corrected ? <Chip tone="neutral" label="Corrected" /> : null}{' '}
            <span className="lims-timeline-actor">{o.recorded_by_display}</span>
            {' · '}
            <When value={o.observed_at} time />
            {o.hours_since_planting !== undefined ? ` · ${hours(o.hours_since_planting)} h after planting` : null}{' '}
            {canCorrect && !o.is_corrected ? (
              <Button size="sm" variant="ghost" onPress={() => onCorrect(o)}>
                Correct
              </Button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
