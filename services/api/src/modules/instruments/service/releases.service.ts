// E02 getAgentConfig + E08 downloadAgentRelease (02-TRD §5.10/§5.11/§7.2; 07-SECURITY E02/E08 rows, S-05, S-09 server half).
// E02 serves the stored signed document unchanged (re-serialising would break the signature). E08 serves only the agent's target
// release, only from LIMS_INSTRUMENTS_RELEASES_DIR, and only bytes matching package_sha256 / package_size.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { LimsError } from '../../../core/errors.js';
import { loadInstrumentsConfig } from '../config.js';
import { createDeviceRepo, type DeviceRepo } from '../repo/device.repo.js';
import { isUuid } from './agents.service.js';
import { activeAgent, deviceScope, type DeviceCtx, type DeviceResult } from './enrolment.service.js';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const internal = () => new LimsError('common.internal');

export function createReleasesService(deps: { repo?: DeviceRepo; releasesDir?: string; now?: () => Date } = {}) {
  const repo = deps.repo ?? createDeviceRepo();
  const releasesDir = () => deps.releasesDir ?? loadInstrumentsConfig().releasesDir;
  return {
    /** E02 — newest stored version; a document that is not this agent's (or none) is never served. */
    async getAgentConfig(ctx: DeviceCtx): Promise<DeviceResult> {
      const s = deviceScope(ctx, 'device_token');
      const agent = await activeAgent(repo, s);
      const cfg = await repo.getLatestConfig(s.tx, s.tenantId, agent.id);
      const doc = cfg?.document;
      if (!cfg || cfg.agent_id !== agent.id || typeof doc !== 'object' || doc === null || doc.agent_id !== agent.id || doc.centre_id !== agent.centre_id) throw internal();
      return { status: 200, body: { alg: 'Ed25519', key_id: cfg.key_id, signature: cfg.signature, document: doc } };
    },

    /** E08 — unknown, inactive and non-target releases are one indistinguishable 404. */
    async downloadAgentRelease(ctx: DeviceCtx, input: { releaseId?: unknown }): Promise<DeviceResult> {
      const s = deviceScope(ctx, 'device_token');
      const agent = await activeAgent(repo, s);
      const releaseId = input?.releaseId;
      if (!isUuid(releaseId)) throw new LimsError('common.not_found');
      const rel = await repo.findRelease(s.tx, releaseId);
      if (!rel || rel.id !== releaseId || rel.is_active !== true) throw new LimsError('common.not_found');
      const cfg = await repo.getLatestConfig(s.tx, s.tenantId, agent.id);
      if (cfg?.document?.update?.target?.release_id !== releaseId) throw new LimsError('common.not_found');

      const dir = releasesDir();
      const name = rel.package_file_name;
      if (!dir || typeof name !== 'string' || !FILE_NAME.test(name) || name.includes('..') || basename(name) !== name) throw internal();
      const root = resolve(dir);
      const file = resolve(root, name);
      if (dirname(file) !== root) throw internal();
      // ponytail: whole package read into memory per request; stream + hash on the fly if packages grow past tens of MB.
      let bytes: Buffer;
      try { bytes = await readFile(file); } catch { throw internal(); }   // message = code only: never the server path
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== Number(rel.package_size) || sha !== rel.package_sha256) throw internal();
      return { status: 200, body: bytes, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-package-sha256': sha } };
    },
  };
}
export type ReleasesService = ReturnType<typeof createReleasesService>;
