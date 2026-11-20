'use client';
// 04-UI-UX §2.4 W4 Phlebotomy phones. Plain-JSON props from the server page (no token, hardware id or sequence number ever reaches here).
// The one write, "Wipe on next connection" (H17, US-13-5), goes through a server action with an Idempotency-Key and If-Match = the phone's version.
// LD-140: kit components only; one primary button per page (none here); every status shows tone, icon and word.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { FilterBar, type FilterDef } from '@lims/ui/components/FilterBar';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { DEVICE_CHANGED, PLATFORM, deviceStatus, failText, hasPerm, humanize, semverLess, toneIcon } from '../labels';
import { DEVICE_STATUSES } from '../query';
import { updateCollectorFlagsAction, wipeDeviceAction } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { DeviceRow, WipeCodes } from '../types';

type Iso = DateTextProps['value'];
const MANAGE = 'homecollection.device.manage';
const WIPE = 'wipe';
const FLAGS = 'collector_flags';
const SETTINGS = 'homecollection.settings.manage'; // updateCollectorFlags x-permission
const WIPEABLE = ['active', 'signed_off'];

export interface DevicesViewProps {
  devices: readonly DeviceRow[];
  codes: WipeCodes;
  /** The tenant's minimum app version; undefined when the setting could not be read (no "Update required" then). */
  minAppVersion?: string | undefined;
  permissions: readonly string[];
  nextCursor?: string | undefined;
  /** The one ?status the page read (DEVICE_STATUSES); undefined = all. */
  status?: string | undefined;
}

const BASE = '/homecollection/devices';
const FILTERS: FilterDef[] = [{ id: 'status', label: 'Status', kind: 'select', options: DEVICE_STATUSES.map((s) => ({ value: s, label: deviceStatus(s)[1] })) }];

const when = (iso: string | undefined) => (iso ? <DateText value={iso as Iso} withTime /> : 'Never');

/** Word + tone + icon for a status: never colour alone. */
function StatusCell({ status }: { status: string }) {
  const [tone, label] = deviceStatus(status);
  return (
    <Inline gap={1}>
      <Icon name={toneIcon(tone)} />
      <StatusChip kind="generic" status={status} tone={tone} label={label} />
    </Inline>
  );
}

/** §2.4 / 03-APP-FLOW §2.4: ConfirmDialog tone=danger, reason from the coded set wipe_reasons (H20). "Other" needs details. */
function WipeDialog({ device, reasons, onClose }: { device: DeviceRow; reasons: WipeCodes['wipe_reasons']; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const done = useRef(false); // the dialog is closing: a further click must not send a second request
  const [error, setError] = useState('');
  const [needText, setNeedText] = useState(false);

  const confirm = async ({ reasonCode, reasonText }: { reasonCode?: string; reasonText?: string }) => {
    if (done.current) return;
    setError('');
    const picked = reasons.find((r) => r.code === reasonCode);
    if (!reasonCode || (picked?.requires_text && !reasonText?.trim())) { setNeedText(true); return; }
    setNeedText(false);
    const res = await wipeDeviceAction(device.id, device.version, reasonCode, reasonText, keyFor(`${reasonCode}|${reasonText ?? ''}`));
    if (!res.ok && res.code === 'common.version_conflict') {
      // H17 409 (already wiped / stale): nothing to retry here, so close and show the plain sentence; the row is not flipped.
      done.current = true;
      toast.show({ tone: 'danger', title: DEVICE_CHANGED });
      router.refresh();
      onClose();
      return;
    }
    if (!res.ok) { setError(failText(res, 'Check the reason and try again.', DEVICE_CHANGED)); return; }
    done.current = true;
    toast.show({ tone: 'success', title: 'Wipe requested. The phone will be wiped the next time it connects.' });
    router.refresh();
    onClose();
  };

  return (
    <ConfirmDialog
      isOpen tone="danger" title={`Wipe ${device.display_name}'s phone on next connection?`} confirmLabel="Wipe phone" onCancel={onClose} onConfirm={confirm}
      requireReason={{ codedSet: 'homecollection.wipe_reasons', options: reasons, freeText: { maxLength: 500, isRequired: false } }}
      body={
        <>
          <p>The phone uploads any pending changes, then erases all home-collection data.</p>
          <p>To block the phone immediately, also revoke the user&apos;s sessions in <a href={device.membership_id ? `/admin/users/${device.membership_id}` : '/admin/users'}>Admin → Users</a>.</p>
          {needText ? <p role="alert" className="lims-error">Enter details for this reason.</p> : null}
          {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
        </>
      }
    />
  );
}

/** T0D-SALES-1 done_when 3 (LD-321, ElabAssist Collection Boy): Allow Collection and Allow Pickup for one collector. There is no read operation for the
 * stored flags, so both start checked (the API default, no row = true) and Save sends ONLY the boxes that were changed (last write wins, no If-Match). */
function CollectorDialog({ device, onClose }: { device: DeviceRow; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [collection, setCollection] = useState(true);
  const [pickup, setPickup] = useState(true);
  const [error, setError] = useState('');
  const changes = { ...(collection ? {} : { allow_collection: false }), ...(pickup ? {} : { allow_pickup: false }) };
  const changed = Object.keys(changes).length > 0;

  const save = async () => {
    if (busy.current || !changed || !device.membership_id) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const res = await updateCollectorFlagsAction(device.membership_id, changes);
      if (!res.ok) { setError(failText(res, 'Check the values and try again.', 'This collector could not be found. Refresh the list and try again.')); return; }
      toast.show({ tone: 'success', title: 'Collector settings saved.' });
      router.refresh();
      onClose();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog title="Collector settings" isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isDisabled={!changed} isLoading={pending} onPress={() => void save()}>Save</Button></>}>
      <div className="lims-stack">
        <p>{device.display_name}</p>
        <Checkbox label="Allow Collection" name="allow_collection" isSelected={collection} onChange={setCollection} description="Off: not offered for new home visits." />
        <Checkbox label="Allow Pickup" name="allow_pickup" isSelected={pickup} onChange={setPickup} description="Off: not offered for sample pickups." />
        {error ? <p role="alert" className="lims-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}

export function DevicesView({ devices, codes, minAppVersion, permissions, nextCursor, status }: DevicesViewProps) {
  const router = useRouter();
  const [wipe, setWipe] = useState<DeviceRow | null>(null);
  const [flags, setFlags] = useState<DeviceRow | null>(null);
  const canWipe = hasPerm(permissions, MANAGE) && codes.wipe_reasons.length > 0;
  const canFlags = hasPerm(permissions, SETTINGS);

  const columns: ColumnDef<DeviceRow>[] = [
    { id: 'who', header: 'Phlebotomist', isRowHeader: true, cell: (d) => d.display_name },
    { id: 'model', header: 'Model', cell: (d) => `${d.model || '—'} (${PLATFORM[d.platform] ?? humanize(d.platform)})` },
    {
      id: 'app', header: 'App version',
      cell: (d) =>
        minAppVersion && semverLess(d.app_version, minAppVersion) ? (
          <Inline gap={2}>
            {d.app_version}
            <Inline gap={1}>
              <Icon name="warning" />
              <StatusChip kind="generic" status="update_required" tone="warning" label="Update required" />
            </Inline>
          </Inline>
        ) : (
          d.app_version || '—'
        ),
    },
    { id: 'status', header: 'Status', cell: (d) => <StatusCell status={d.status} /> },
    { id: 'seen', header: 'Last seen', cell: (d) => when(d.last_seen_at) },
    { id: 'push', header: 'Last upload', cell: (d) => when(d.last_push_at) },
    { id: 'snapshot', header: 'Last route download', cell: (d) => when(d.last_snapshot_at) },
  ];

  return (
    <div>
      <PageHeader title="Phlebotomy phones" helpKey="homecollection.devices" actions={<Button onPress={() => router.refresh()}>Refresh</Button>} />
      {/* T0D-UILIST-3, LD-353 template 1: one FilterBar; the page already reads ?status (H16 query). */}
      <FilterBar
        filters={FILTERS} value={status ? { status } : {}}
        onChange={(v) => { const s = typeof v['status'] === 'string' ? v['status'] : undefined; if (s !== status) router.replace(s ? `${BASE}?status=${s}` : BASE); }}
        onReset={() => router.replace(BASE)}
      />
      <DataTable<DeviceRow>
        caption="Phlebotomy phones" columns={columns} rows={devices} getRowId={(d) => d.id} density="compact" cellTitle
        emptyState={{ title: 'No phones registered yet. Phones appear after the first sign-in.' }}
        {...(canWipe || canFlags
          ? {
              rowActions: (d: DeviceRow) => [
                ...(canFlags && d.membership_id ? [{ id: FLAGS, label: 'Collector settings' }] : []),
                ...(canWipe && WIPEABLE.includes(d.status) ? [{ id: WIPE, label: 'Wipe on next connection', isDanger: true }] : []),
              ],
              onRowActionMenu: (d: DeviceRow, id: string) => { if (id === WIPE) setWipe(d); else if (id === FLAGS) setFlags(d); },
            }
          : {})}
        {...(nextCursor ? { page: { hasNext: true, hasPrevious: false, onNext: () => router.push(`/homecollection/devices?cursor=${encodeURIComponent(nextCursor)}`), onPrevious: () => router.back(), limit: 100 } } : {})}
      />
      {flags ? <CollectorDialog key={flags.id} device={flags} onClose={() => setFlags(null)} /> : null}
      {wipe ? <WipeDialog key={`${wipe.id}:${wipe.version}`} device={wipe} reasons={codes.wipe_reasons} onClose={() => setWipe(null)} /> : null}
    </div>
  );
}
