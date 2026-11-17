// DeviceDto (02-TRD §5.3, contracts/openapi/homecollection.yaml DeviceDto): optional fields are absent, never null; timestamps IsoUtc; no signed_off_at / wipe reason in the DTO.
type Obj = Record<string, any>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

export function toDeviceDto(row: Obj, displayName: string): Obj {
  const opt = (k: string): Obj => (row[k] === null || row[k] === undefined ? {} : { [k]: iso(row[k]) });
  return {
    id: row['id'], version: Number(row['version']), membership_id: row['membership_id'], display_name: displayName, platform: row['platform'],
    os_version: row['os_version'], app_version: row['app_version'], ...(row['model'] === null || row['model'] === undefined ? {} : { model: row['model'] }),
    status: row['status'], registered_at: iso(row['registered_at']), ...opt('last_seen_at'), ...opt('last_snapshot_at'), ...opt('last_push_at'),
    max_device_seq_received: Number(row['max_device_seq_received']), ...opt('wipe_requested_at'), ...opt('wiped_at'),
  };
}
