// instruments.publish_release_configs (02-TRD §5.10 `release_changed`, §10; AC-15.5 release half).
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { jobTenant, type Ctx } from './shared.js';

/** Canonical JSON of 02-TRD §5.10: keys sorted, no whitespace, minimal string escapes (control chars as \u00xx), integers only. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') {
    return `"${v.replace(/["\\\u0000-\u001f]/g, (c) => (c === '"' ? '\\"' : c === '\\' ? '\\\\' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))}"`;
  }
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('canonical JSON: integers only'); return String(v); }
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    // ponytail: UTF-16 sort = code-point sort for the ASCII keys of lims.bridge.config.v1; use a code-point comparator if non-BMP keys ever appear
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${canonicalJson(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error('canonical JSON: unsupported value');
}

function signingKey(): { key: KeyObject; keyId: string } {
  const file = process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE;
  const keyId = process.env.LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID;
  if (!file || !keyId || keyId.length > 32) throw new Error('publish_release_configs: config signing key is not configured');
  let key: KeyObject;
  try { key = createPrivateKey(readFileSync(file)); } catch { throw new Error('publish_release_configs: config signing key cannot be read'); }  // never echo the file
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('publish_release_configs: config signing key is not Ed25519');
  return { key, keyId };
}

const semver = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!; return false; };

/** 02-TRD §5.10: an active pin wins; else the highest active version of the agent's channel (beta agents also see stable). */
function selectRelease(agent: { update_channel: string; pinned_release_id: string | null }, active: readonly any[]): any | null {
  const pin = agent.pinned_release_id ? active.find((r) => r.id === agent.pinned_release_id) : undefined;
  if (pin) return pin;
  let best: any = null;
  for (const r of active) if ((r.channel === agent.update_channel || (agent.update_channel === 'beta' && r.channel === 'stable')) && (!best || newer(r.version, best.version))) best = r;
  return best;
}

const target = (r: any) => (r ? {
  release_id: r.id, version: r.version, package_sha256: r.package_sha256, package_size: Number(r.package_size), signature: r.signature,
  key_id: r.key_id, authenticode_publisher: r.authenticode_publisher,
} : null);

const RELEASES_SQL = `SELECT id, version, channel, package_sha256, package_size, signature, key_id, authenticode_publisher, is_active
  FROM instruments.g_agent_releases WHERE is_active`;
const AGENTS_SQL = `SELECT a.id AS agent_id, a.centre_id, a.status, a.update_channel, a.pinned_release_id, a.latest_config_version, c.config_version, c.document
  FROM instruments.agents a
  JOIN instruments.agent_config_versions c ON c.tenant_id = a.tenant_id AND c.agent_id = a.id AND c.config_version = a.latest_config_version
  WHERE a.tenant_id = $1 AND a.status <> 'retired'
  FOR UPDATE OF a`;
const INSERT_SQL = `INSERT INTO instruments.agent_config_versions
  (id, tenant_id, centre_id, agent_id, config_version, document, canonical_sha256, signature, key_id, issued_at, reason, created_by)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`;
const BUMP_SQL = `UPDATE instruments.agents SET latest_config_version = $3, updated_at = $4, updated_by = $5, version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND latest_config_version = $6`;

export async function publishReleaseConfigs(payload: { tenant_id?: unknown }, ctx: Ctx): Promise<void> {
  const tenantId = jobTenant(payload, ctx);
  const active = (await ctx.tx.query(RELEASES_SQL)).rows.filter((r: any) => r.is_active === true);
  const agents = (await ctx.tx.query(AGENTS_SQL, [tenantId])).rows.filter((a: any) => a.status !== 'retired');
  const now = ctx.now();
  const todo: Array<{ a: any; doc: any }> = [];
  for (const a of agents) {
    const current = typeof a.document === 'string' ? JSON.parse(a.document) : a.document;
    if (!current || typeof current !== 'object' || a.config_version !== a.latest_config_version) throw new Error('publish_release_configs: latest config version missing');
    const sel = selectRelease(a, active);
    if ((sel?.id ?? null) === (current.update?.target?.release_id ?? null)) continue;          // no change -> no version (idempotent)
    todo.push({ a, doc: {
      ...current, config_version: a.latest_config_version + 1, issued_at: now,
      update: { ...current.update, target: target(sel), allow_downgrade: a.pinned_release_id !== null && a.pinned_release_id !== undefined },
    } });
  }
  if (todo.length === 0) return;
  const { key, keyId } = signingKey();                 // before any write: never an unsigned document
  for (const { a, doc } of todo) {
    const bytes = Buffer.from(canonicalJson(doc), 'utf8');
    const signature = sign(null, bytes, key).toString('base64url');
    await ctx.tx.query(INSERT_SQL, [uuidv7(), tenantId, a.centre_id, a.agent_id, doc.config_version, JSON.stringify(doc),
      createHash('sha256').update(bytes).digest('hex'), signature, keyId, now, 'release_changed', ctx.actor.id]);
    const upd = await ctx.tx.query(BUMP_SQL, [tenantId, a.agent_id, doc.config_version, now, ctx.actor.id, a.latest_config_version]);
    if (upd.rowCount === 0) throw new Error('publish_release_configs: agent changed concurrently');
  }
  ctx.log.info('instruments.publish_release_configs', { versions: todo.length });
}
