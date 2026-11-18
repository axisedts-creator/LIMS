'use client';
// T0D-OFFLINE-3 (LD-322): badge, document number (final after sync), watermark, block warning. No provider: value as is or nothing.
import { useEffect, useState } from 'react';
import { t } from '../../i18n/messages';
import { tf } from '../chip';
import type { RecordStatus } from '../flows';
import type { BlockSeries } from '../numbers';
import { useOfflineFlows, useOfflineSnapshot } from './OfflineProvider';

const isProvisional = (n: unknown) => typeof n === 'string' && n.startsWith('OFF-');

/** resolves each number through flows.display; again whenever the controller snapshot changes (a sync settled) */
export function useDocNumbers(values: readonly string[]): string[] {
  const flows = useOfflineFlows();
  const tick = useOfflineSnapshot()?.now;
  const key = values.join('\u0000');
  const [out, setOut] = useState<string[]>(() => values.slice());
  useEffect(() => {
    setOut(values.slice());
    if (!flows || !values.some(isProvisional)) return;
    let gone = false;
    Promise.all(values.map((v) => flows.display(v).catch(() => v))).then((r) => { if (!gone) setOut(r); }, () => undefined);
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for values
  }, [flows, key, tick]);
  return out.length === values.length ? out : values.slice();
}

export function DocNumber({ value, className }: { value: string; className?: string }) {
  const [shown] = useDocNumbers([value]);
  return <span className={className} data-provisional={isProvisional(shown) || undefined}>{shown}</span>;
}

/** Given numbers, it shows only while one of them is still provisional; without numbers it always shows. */
export function IssuedOfflineWatermark({ numbers }: { numbers?: readonly string[] }) {
  const shown = useDocNumbers(numbers ?? []);
  if (numbers && !shown.some(isProvisional)) return null;
  return <div className="lims-offline-watermark" aria-label={t('offline.watermark')}>{t('offline.watermark')}</div>;
}

export function PendingSyncBadge({ status, id }: { status?: RecordStatus | null; id?: string }) {
  const flows = useOfflineFlows();
  const tick = useOfflineSnapshot()?.now;
  const [found, setFound] = useState<RecordStatus | null>(null);
  useEffect(() => {
    if (status !== undefined || !id || !flows) return;
    let gone = false;
    flows.statusOf(id).then((s) => { if (!gone) setFound(s); }, () => undefined);
    return () => { gone = true; };
  }, [status, id, flows, tick]);
  const s = status !== undefined ? status : found;
  if (!s) return null;
  return <span role="status" className={`lims-chip lims-chip-${s.state === 'pending' ? 'warn' : 'danger'}`}>{t(`offline.badge.${s.state}`)}</span>;
}

export function BlockWarning({ series }: { series: BlockSeries }) {
  const flows = useOfflineFlows();
  const tick = useOfflineSnapshot()?.now;
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!flows) return;
    let gone = false;
    flows.numbers.remaining(series).then((r) => { if (!gone) setLeft(r.warn ? r.left : null); }, () => undefined);
    return () => { gone = true; };
  }, [flows, series, tick]);
  if (!flows || left === null) return null;
  return <div role="alert" className="lims-alert lims-alert-warn">{tf('offline.block.low', { what: t(`offline.block.${series}`), n: left })}</div>;
}
