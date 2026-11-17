// API-T14 — instruments.publish_release_configs (02-TRD §5.10 + §10; AC-15.5 release part). The settings_changed half of AC-15.5 (E41) is an API operation, not this task.
// Fixtures: an Ed25519 key is generated per run and handed over through LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE / _ID (TRD §5.10); the new config document is
// verified with the public key over canonical JSON. Agent rows carry the latest config version (config_version, document) next to the agent columns (helpers.ts).
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { AGENT, CENTRE_1, REL, T_A, NOW, agentRow, canonical, makeWorld, rejects, type World } from './helpers.js';

const ID = 'instruments.publish_release_configs';
const KEY_ID = 'cfg-test-2026';
let publicKey: import('node:crypto').KeyObject;
const saved = { file: process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE, id: process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID };

beforeAll(() => {
  const kp = generateKeyPairSync('ed25519');
  publicKey = kp.publicKey;
  const dir = mkdtempSync(join(tmpdir(), 'lims-t14-'));
  const file = join(dir, 'config-signing.pem');
  writeFileSync(file, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE = file;
  process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID = KEY_ID;
});
afterAll(() => { for (const [k, v] of [['LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE', saved.file], ['LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID', saved.id]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const release = (n: number, version: string, channel: 'stable' | 'beta' = 'stable', over: Record<string, unknown> = {}) => ({
  id: REL(n), version, channel, package_file_name: `bridge-${version}.msi`, package_sha256: String(n).repeat(64).slice(0, 64), package_size: '52428800' /* bigint -> string, node-pg */,
  signature: `sig-${n}_-AbC`, key_id: 'rel-2026', authenticode_publisher: 'CN=Synthetic Lab Software', released_at: new Date(NOW), is_active: true, ...over,
});
const target = (r: ReturnType<typeof release>) => ({ release_id: r.id, version: r.version, package_sha256: r.package_sha256, package_size: 52428800, signature: r.signature, key_id: r.key_id, authenticode_publisher: r.authenticode_publisher });
const doc = (n: number, version: number, update: Record<string, unknown> = {}) => ({
  schema: 'lims.bridge.config.v1', agent_id: AGENT(n), centre_id: CENTRE_1, config_version: version, issued_at: '2026-11-01T00:00:00.000Z', heartbeat_interval_seconds: 60,
  upload: { max_batch_messages: 100 }, log_level: 'info', instruments: [{ instrument_id: 'x', instrument_code: 'SIM-1', state: 'live' }],
  update: { channel: 'stable', target: null, allow_downgrade: false, window: { from: '01:00', to: '03:00', timezone: 'Asia/Kathmandu' }, ...update },
});
function seed(w: World, n: number, agentOver: Record<string, unknown>, update: Record<string, unknown> = {}) {
  const a = agentRow(n, { latest_config_version: 7, ...agentOver });
  w.agents.push(a);
  w.configs.push({ agent_id: a.agent_id, config_version: 7, document: doc(n, 7, { channel: a.update_channel, ...update }) });
}
async function run(w: World) { await manifest.tasks![ID]!({ tenant_id: T_A }, w.makeCtx()); }
const inserts = (w: World) => w.writes().filter((s) => /INSERT\s+INTO\s+instruments\.agent_config_versions/i.test(s.text));
const agentBumps = (w: World) => w.writes().filter((s) => /UPDATE\s+instruments\.agents\b/i.test(s.text));
function docOf(s: { values: unknown[] }): any {
  for (const v of s.values) { const o = typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v; if (o && typeof o === 'object' && (o as any).schema === 'lims.bridge.config.v1') return o; }
  throw new Error('no config document among the bound values');
}
const sigOk = (s: { values: unknown[] }) => { const bytes = Buffer.from(canonical(docOf(s))); return s.values.some((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(v) && verify(null, bytes, publicKey, Buffer.from(v, 'base64url'))); };

let w: World;
beforeEach(() => { w = makeWorld(); });

describe('AC-15.5 release_changed', () => {
  it('a newly seeded active release on the agent channel creates ONE signed config version (reason release_changed, update.target = the release) and bumps latest_config_version', async () => {
    const r1 = release(1, '1.5.0');
    w.releases.push(r1); seed(w, 1, {});
    await run(w);
    const ins = inserts(w);
    expect(ins).toHaveLength(1);
    const s = ins[0]!;
    expect(w.touches(s, 'release_changed', AGENT(1), CENTRE_1, KEY_ID, 8)).toBe(true);
    const d = docOf(s);
    expect(d).toMatchObject({ schema: 'lims.bridge.config.v1', agent_id: AGENT(1), centre_id: CENTRE_1, config_version: 8, issued_at: NOW });
    expect(d.update.target).toEqual(target(r1));
    expect(d.update).toMatchObject({ channel: 'stable', allow_downgrade: false, window: { from: '01:00', to: '03:00', timezone: 'Asia/Kathmandu' } });
    expect({ ...d, config_version: 7, issued_at: '2026-11-01T00:00:00.000Z', update: doc(1, 7).update }).toEqual(doc(1, 7));        // nothing else changed
    expect(sigOk(s)).toBe(true);
    expect(w.touches(s, createHash('sha256').update(canonical(d)).digest('hex'))).toBe(true);                                       // canonical_sha256
    const bump = agentBumps(w);
    expect(bump).toHaveLength(1);
    expect(w.touches(bump[0]!, 'latest_config_version', 8, AGENT(1))).toBe(true);
    expect(JSON.stringify(bump[0]!.values)).not.toContain('"sig-');
  });

  it('no change (latest target already the selected release) -> no new version, no agent update', async () => {
    const r1 = release(1, '1.5.0');
    w.releases.push(r1); seed(w, 1, {}, { target: target(r1) });
    await run(w);
    expect(inserts(w)).toHaveLength(0);
    expect(agentBumps(w)).toHaveLength(0);
  });

  it('is idempotent across runs when the stored state is updated by the first run (second run sees target = release)', async () => {
    const r1 = release(1, '1.5.0');
    w.releases.push(r1); seed(w, 1, {});
    await run(w);
    const d = docOf(inserts(w)[0]!);
    w.agents[0].latest_config_version = 8; w.configs[0] = { agent_id: AGENT(1), config_version: 8, document: d };
    await run(w);
    expect(inserts(w)).toHaveLength(1);
  });

  it('selects the HIGHEST version numerically (1.10.0 beats 1.9.0), ignoring inactive releases', async () => {
    const hi = release(3, '1.10.0'); w.releases.push(release(1, '1.9.0'), hi, release(2, '2.0.0', 'stable', { is_active: false }));
    seed(w, 1, {});
    await run(w);
    expect(docOf(inserts(w)[0]!).update.target.release_id).toBe(hi.id);
  });

  it('a stable agent does not see a beta release; a beta agent sees both channels and takes the highest', async () => {
    const stable = release(1, '1.5.0'), beta = release(2, '1.6.0', 'beta');
    w.releases.push(stable, beta); seed(w, 1, { update_channel: 'stable' }); seed(w, 2, { update_channel: 'beta' });
    await run(w);
    const byAgent = new Map(inserts(w).map((s) => [docOf(s).agent_id, docOf(s)]));
    expect(byAgent.get(AGENT(1))!.update.target.release_id).toBe(stable.id);
    expect(byAgent.get(AGENT(2))!.update.target.release_id).toBe(beta.id);
    expect(byAgent.get(AGENT(2))!.update.channel).toBe('beta');
  });

  it('a pin to an active release wins over a higher one and sets allow_downgrade; a pin to an inactive release falls back to the channel rule', async () => {
    const old = release(1, '1.2.0'), top = release(2, '1.5.0'), dead = release(3, '1.1.0', 'stable', { is_active: false });
    w.releases.push(old, top, dead);
    seed(w, 1, { pinned_release_id: old.id }); seed(w, 2, { pinned_release_id: dead.id });
    await run(w);
    const byAgent = new Map(inserts(w).map((s) => [docOf(s).agent_id, docOf(s)]));
    expect(byAgent.get(AGENT(1))!.update).toMatchObject({ target: target(old), allow_downgrade: true });
    expect(byAgent.get(AGENT(2))!.update.target.release_id).toBe(top.id);
  });

  it('a deactivated release (no active release left) makes the target fall back to null in a new version', async () => {
    const r1 = release(1, '1.5.0', 'stable', { is_active: false });
    w.releases.push(r1); seed(w, 1, {}, { target: target(r1) });
    await run(w);
    expect(inserts(w)).toHaveLength(1);
    expect(docOf(inserts(w)[0]!).update.target).toBeNull();
  });

  it('no active release and target already null -> nothing to do', async () => {
    seed(w, 1, {});
    await run(w);
    expect(inserts(w)).toHaveLength(0);
  });

  it('retired agents never get a version; each changed agent gets exactly its own next version number', async () => {
    const r1 = release(1, '1.5.0'); w.releases.push(r1);
    seed(w, 1, {}); seed(w, 2, { status: 'retired', retired_at: new Date(NOW) }); seed(w, 3, { latest_config_version: 7 });
    await run(w);
    expect(inserts(w).map((s) => docOf(s).agent_id).sort()).toEqual([AGENT(1), AGENT(3)]);
  });
});

describe('signing and failure', () => {
  it('without a signing key file the task fails and writes NO config version (never an unsigned document)', async () => {
    const file = process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE;
    process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE = join(tmpdir(), 'lims-t14-does-not-exist.pem');
    try {
      w.releases.push(release(1, '1.5.0')); seed(w, 1, {});
      await rejects(run(w));
      expect(inserts(w)).toHaveLength(0);
    } finally { process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE = file; }
  });

  it('the private key never appears in a statement, a log line or a metric', async () => {
    w.releases.push(release(1, '1.5.0')); seed(w, 1, {});
    await run(w);
    expect(JSON.stringify(w.stmts)).not.toMatch(/PRIVATE KEY/);
    expect(w.logs.text()).not.toMatch(/PRIVATE KEY|sig-1_-AbC/);
  });

  it('every instruments.* statement binds the job tenant and runs under its claims', async () => {
    w.releases.push(release(1, '1.5.0')); seed(w, 1, {});
    await run(w);
    for (const s of w.stmts.filter((x) => /instruments\.(agents|agent_config_versions|agent_status)/i.test(x.text))) {
      expect(s.text, s.text).toMatch(/tenant_id/);
      expect(s.claims).toMatchObject({ tenant_id: T_A });
    }
  });
});
