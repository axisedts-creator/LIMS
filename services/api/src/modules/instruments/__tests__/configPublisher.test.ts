// Tests for ConfigPublisher (02-TRD §5.10, signed lims.bridge.config.v1 generation & Ed25519 signatures).
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConfigPublisher } from '../service/configPublisher.js';
import { canonicalJson, canonicalSha256 } from '../service/signing.js';
import type { ConfigRepo, Row } from '../repo/config.repo.js';
import { AGENT_A1, CENTRE_A1, INS, TENANT_A, USER, idN } from './instruments.helpers.js';

function fakeConfigRepo(seed: {
  agent?: Row;
  instruments?: Row[];
  settings?: Row;
  release?: Row;
} = {}) {
  const agent = seed.agent ?? {
    id: AGENT_A1,
    tenant_id: TENANT_A,
    centre_id: CENTRE_A1,
    status: 'active',
    update_channel: 'stable',
    pinned_release_id: null,
    latest_config_version: 1,
  };
  const versions: Row[] = [];

  const repo: ConfigRepo = {
    async nextAgentVersion(_tx, tenantId, agentId, o) {
      if (tenantId !== agent.tenant_id || agentId !== agent.id || agent.status === 'retired') return undefined;
      if (o.initialOnly && !versions.some((v) => v['configVersion'] === agent.latest_config_version)) {
        return { ...agent };
      }
      agent.latest_config_version += 1;
      return { ...agent };
    },
    async listAgentInstruments(_tx, tenantId, agentId) {
      if (tenantId !== agent.tenant_id || agentId !== agent.id) return [];
      return (seed.instruments ?? []).filter((i) => ['commissioning', 'live', 'suspended'].includes(i['state']));
    },
    async getSettings() {
      return seed.settings;
    },
    async resolveRelease() {
      return seed.release;
    },
    async insertConfigVersion(_tx, tenantId, row) {
      versions.push({ ...row, tenantId });
    },
  };
  return { repo, agent, versions };
}

describe('createConfigPublisher (02-TRD §5.10)', () => {
  it('publishes v1 for agent_created without bumping to v2, then increments for instrument_changed & signs verifiably with Ed25519', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const h80 = {
      id: INS(1),
      instrument_code: 'SYN-H80E-1',
      driver_code: 'truth_h80e',
      protocol: 'hl7v2',
      state: 'live',
      cap_host_query: true,
      cap_worklist_download: false,
      transport: { kind: 'tcp_server', bind_address: '192.168.1.2', port: 8001, allowed_peers: ['192.168.1.3'] },
      protocol_options: { hl7v2: { ack_mode: 'auto' } },
      parser_options: {},
      file_drop: null,
      timezone: 'Asia/Kathmandu',
      is_active: true,
    };
    const draft = { ...h80, id: INS(2), instrument_code: 'SYN-DRAFT-2', state: 'draft' };

    const { repo, versions } = fakeConfigRepo({
      instruments: [h80, draft],
      settings: { agent_uploaded_retention_hours: 48, update_window_from: '01:00:00', update_window_to: '04:00:00' },
    });

    const publish = createConfigPublisher({
      repo,
      signingKey: privateKey,
      signingKeyId: 'cfg-2026-test',
      now: () => new Date('2026-11-25T06:00:00.000Z'),
    });

    const v1 = await publish({}, { tenantId: TENANT_A, agentId: AGENT_A1, reason: 'agent_created', actorId: USER });
    expect(v1).toBe(1);
    const v2 = await publish({}, { tenantId: TENANT_A, agentId: AGENT_A1, reason: 'instrument_changed', actorId: USER });
    expect(v2).toBe(2);

    expect(versions).toHaveLength(2);
    const latest = versions[1]!;
    expect(latest['keyId']).toBe('cfg-2026-test');
    expect(latest['reason']).toBe('instrument_changed');

    const doc = latest['document'] as Record<string, any>;
    expect(doc.schema).toBe('lims.bridge.config.v1');
    expect(doc.config_version).toBe(2);
    expect(doc.upload.uploaded_retention_hours).toBe(48);
    expect(doc.update.window).toEqual({ from: '01:00', to: '04:00', timezone: 'Asia/Kathmandu' });
    expect(doc.instruments).toHaveLength(1);
    expect(doc.instruments[0].instrument_code).toBe('SYN-H80E-1');
    expect(doc.instruments[0].enabled).toBe(true);

    const canon = canonicalJson(doc);
    expect(latest['canonicalSha256']).toBe(canonicalSha256(doc));
    expect(verify(null, Buffer.from(canon, 'utf8'), publicKey, Buffer.from(String(latest['signature']), 'base64url'))).toBe(true);
  });

  it('includes release target metadata when a release row exists and marks suspended instruments disabled', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const susp = {
      id: INS(3),
      instrument_code: 'SYN-METIS-3',
      driver_code: 'getein_metis',
      protocol: 'hl7v2',
      state: 'suspended',
      cap_host_query: false,
      cap_worklist_download: false,
      transport: { kind: 'tcp_server', bind_address: '192.168.1.2', port: 9001, allowed_peers: ['192.168.1.4'] },
      protocol_options: {},
      parser_options: {},
      file_drop: null,
      timezone: 'Asia/Kathmandu',
      is_active: true,
    };
    const { repo, versions } = fakeConfigRepo({
      instruments: [susp],
      release: {
        id: idN(0x9001),
        version: '1.2.3',
        package_sha256: 'a'.repeat(64),
        package_size: 1024000,
        signature: 'sig',
        key_id: 'rel-1',
        authenticode_publisher: 'CN=LIMS',
      },
    });
    const publish = createConfigPublisher({ repo, signingKey: privateKey, signingKeyId: 'cfg-2' });
    await publish({}, { tenantId: TENANT_A, agentId: AGENT_A1, reason: 'release_changed', actorId: USER });
    const doc = versions[0]!['document'] as Record<string, any>;
    expect(doc.instruments[0].enabled).toBe(false);
    expect(doc.update.target).toMatchObject({ version: '1.2.3', package_size: 1024000, key_id: 'rel-1' });
  });

  it('fails closed with common.internal when no signing key is configured', async () => {
    const { repo } = fakeConfigRepo();
    const publish = createConfigPublisher({ repo, signingKeyId: '', signingKeyFile: '' });
    await expect(publish({}, { tenantId: TENANT_A, agentId: AGENT_A1, reason: 'agent_created', actorId: USER })).rejects.toMatchObject({ code: 'common.internal' });
  });
});
