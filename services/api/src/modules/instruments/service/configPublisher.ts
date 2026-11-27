// Builds, canonically hashes, signs (Ed25519), and persists `lims.bridge.config.v1` snapshots inside the caller tx (02-TRD §5.10).
import type { KeyObject } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { loadInstrumentsConfig } from '../config.js';
import { createConfigRepo, type ConfigRepo, type Row, type Tx } from '../repo/config.repo.js';
import type { ConfigPublishReason, ConfigPublisher } from './instruments.service.js';
import { canonicalSha256, loadSigningKey, signConfigDocument } from './signing.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export interface ConfigPublisherDeps {
  repo?: ConfigRepo;
  now?: () => Date;
  signingKey?: KeyObject | string;
  signingKeyFile?: string;
  signingKeyId?: string;
  spkiPinsSha256?: readonly string[];
  timezone?: string;
}

const hhmm = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 5));

function parsePins(envVal: string | undefined): string[] {
  if (!envVal) return [];
  return envVal
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

function buildInstrumentEntry(r: Row) {
  return {
    instrument_id: String(r['id']),
    instrument_code: String(r['instrument_code']),
    driver_code: String(r['driver_code']),
    protocol: String(r['protocol']),
    state: String(r['state']),
    enabled: r['state'] !== 'suspended' && Boolean(r['is_active']),
    capabilities: {
      host_query: Boolean(r['cap_host_query']),
      worklist_download: Boolean(r['cap_worklist_download']),
    },
    transport: r['transport'],
    protocol_options: r['protocol_options'] ?? {},
    parser_options: r['parser_options'] ?? {},
    file_drop: r['file_drop'] ?? null,
    timezone: String(r['timezone'] ?? 'Asia/Kathmandu'),
  };
}

function buildTarget(rel: Row | undefined) {
  if (!rel) return null;
  return {
    release_id: String(rel['id']),
    version: String(rel['version']),
    package_sha256: String(rel['package_sha256']),
    package_size: Number(rel['package_size']),
    signature: String(rel['signature']),
    key_id: String(rel['key_id']),
    authenticode_publisher: String(rel['authenticode_publisher']),
  };
}

export function createConfigPublisher(deps: ConfigPublisherDeps = {}): ConfigPublisher {
  const repo = deps.repo ?? createConfigRepo();
  const now = deps.now ?? (() => new Date());
  let cachedKey: { file?: string; key: KeyObject } | undefined;

  function resolveKey(): { key: KeyObject | string; keyId: string; pins: string[] } {
    const cfg = loadInstrumentsConfig();
    const keyId = deps.signingKeyId ?? cfg.configSigningKeyId;
    const keyFile = deps.signingKeyFile ?? cfg.configSigningKeyFile;
    const pins = deps.spkiPinsSha256 ? [...deps.spkiPinsSha256] : parsePins(process.env.LIMS_INSTRUMENTS_SPKI_PINS_SHA256);

    if (!keyId || keyId.length < 1 || keyId.length > 32) {
      throw new LimsError('common.internal');
    }
    if (deps.signingKey) {
      return { key: deps.signingKey, keyId, pins };
    }
    if (!keyFile) {
      throw new LimsError('common.internal');
    }
    if (!cachedKey || cachedKey.file !== keyFile) {
      cachedKey = { file: keyFile, key: loadSigningKey(keyFile) };
    }
    return { key: cachedKey.key, keyId, pins };
  }

  return async (tx: unknown, o: { tenantId: string; agentId: string; reason: ConfigPublishReason; actorId: string }): Promise<number> => {
    const dbTx = tx as Tx;
    const { key, keyId, pins } = resolveKey();
    const issuedAt = now().toISOString();

    const agent = await repo.nextAgentVersion(dbTx, o.tenantId, o.agentId, {
      initialOnly: o.reason === 'agent_created',
      nowIso: issuedAt,
      actorId: o.actorId,
    });
    if (!agent) throw new LimsError('common.not_found');

    const configVersion = Number(agent['latest_config_version']);
    const [instruments, settings, rel] = await Promise.all([
      repo.listAgentInstruments(dbTx, o.tenantId, o.agentId),
      repo.getSettings(dbTx, o.tenantId),
      repo.resolveRelease(dbTx, {
        channel: String(agent['update_channel']),
        pinnedReleaseId: (agent['pinned_release_id'] as string | null) ?? null,
      }),
    ]);

    const winFrom = hhmm(settings?.['update_window_from']);
    const winTo = hhmm(settings?.['update_window_to']);
    const retentionHours = Number(settings?.['agent_uploaded_retention_hours'] ?? 24);
    const tz = deps.timezone ?? (await repo.getTenantTimezone?.(dbTx, o.tenantId)) ?? 'Asia/Kathmandu';

    const document = {
      schema: 'lims.bridge.config.v1',
      agent_id: String(agent['id']),
      centre_id: String(agent['centre_id']),
      config_version: configVersion,
      issued_at: issuedAt,
      heartbeat_interval_seconds: 60,
      upload: {
        max_batch_messages: 50,
        max_batch_bytes: 2097152,
        flush_interval_seconds: 5,
        uploaded_retention_hours: retentionHours,
      },
      rate_budget: {
        requests_per_minute: 120,
        reserved_host_query_per_minute: 60,
        reserved_heartbeat_per_minute: 2,
      },
      tls: {
        spki_pins_sha256: pins,
      },
      log_level: 'info',
      update: {
        channel: String(agent['update_channel']),
        target: buildTarget(rel),
        allow_downgrade: false,
        window: winFrom && winTo ? { from: winFrom, to: winTo, timezone: tz } : null,
      },
      instruments: instruments.map(buildInstrumentEntry),
    };

    const sha256 = canonicalSha256(document);
    const envelope = signConfigDocument(document, { privateKey: key, keyId });

    await repo.insertConfigVersion(dbTx, o.tenantId, {
      id: uuidv7(),
      centreId: String(agent['centre_id']),
      agentId: String(agent['id']),
      configVersion,
      document,
      canonicalSha256: sha256,
      signature: envelope.signature,
      keyId: envelope.key_id,
      issuedAt,
      reason: o.reason,
      actorId: o.actorId,
    });

    return configVersion;
  };
}
