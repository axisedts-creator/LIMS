'use client';
// 04-UI-UX §2.4 W4 Phlebotomy phones. Plain-JSON props from the server page (no token, hardware id or sequence number ever reaches here).
// The one write, "Wipe on next connection" (H17, US-13-5), goes through a server action with an Idempotency-Key and If-Match = the phone's version.
// LD-140: kit components only; one primary button per page (none here); every status shows tone, icon and word.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { DEVICE_CHANGED, PLATFORM, deviceStatus, failText, hasPerm, humanize, semverLess, toneIcon } from '../labels';
import { wipeDeviceAction } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { DeviceRow, WipeCodes } from '../types';

type Iso = DateTextProps['value'];
const MANAGE = 'homecollection.device.manage';
const WIPE = 'wipe';
const WIPEABLE = ['active', 'signed_off'];

export interface DevicesViewProps {
  devices: readonly DeviceRow[];
  codes: WipeCodes;
  /** The tenant's minimum app version; undefined when the setting could not be read (no "Update required" then). */
  minAppVersion?: string | undefined;
  permissions: readonly string[];
  nextCursor?: string | undefined;
}

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

export function DevicesView({ devices, codes, minAppVersion, permissions, nextCursor }: DevicesViewProps) {
  const router = useRouter();
  const [wipe, setWipe] = useState<DeviceRow | null>(null);
  const canWipe = hasPerm(permissions, MANAGE) && codes.wipe_reasons.length > 0;

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
      <DataTable<DeviceRow>
        caption="Phlebotomy phones" columns={columns} rows={devices} getRowId={(d) => d.id} density="compact"
        emptyState={{ title: 'No phones registered yet. Phones appear after the first sign-in.' }}
        {...(canWipe
          ? {
              rowActions: (d: DeviceRow) => (WIPEABLE.includes(d.status) ? [{ id: WIPE, label: 'Wipe on next connection', isDanger: true }] : []),
              onRowActionMenu: (d: DeviceRow, id: string) => { if (id === WIPE) setWipe(d); },
            }
          : {})}
        {...(nextCursor ? { page: { hasNext: true, hasPrevious: false, onNext: () => router.push(`/homecollection/devices?cursor=${encodeURIComponent(nextCursor)}`), onPrevious: () => router.back(), limit: 100 } } : {})}
      />
      {wipe ? <WipeDialog key={`${wipe.id}:${wipe.version}`} device={wipe} reasons={codes.wipe_reasons} onClose={() => setWipe(null)} /> : null}
    </div>
  );
}
