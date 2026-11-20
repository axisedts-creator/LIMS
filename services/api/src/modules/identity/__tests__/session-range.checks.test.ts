// T0B-SESSRANGE-1 (LD-304, LD-306): the OpenAPI bounds of the two tenant settings fields equal the CHECKs the first identity migration already put on
// identity.tenant_settings (idle 15..30, absolute 1..12; 04-consolidated-decisions A8, REQ-SEC-073). No new migration exists (LD-306): this one static test pins contract to schema.
// Synthetic data only.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';

const DIR = join(REPO_ROOT, 'db', 'migrations');
const FIRST = '20261105001300_identity__create_identity_schema.sql';
const sql = readFileSync(join(DIR, FIRST), 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const SCHEMAS = ['TenantSettingsDto', 'PlatformTenantSettingsDto', 'TenantSettingsPatch'] as const;

/** [min, max] of `CONSTRAINT <name> CHECK (<column> BETWEEN a AND b)` in the first identity migration */
function checkRange(name: string, column: string): [number, number] {
  const m = sql.match(new RegExp(`CONSTRAINT ${name} CHECK \\(${column} BETWEEN (\\d+) AND (\\d+)\\)`));
  if (!m) throw new Error(`${name} not found in ${FIRST}`);
  return [Number(m[1]), Number(m[2])];
}

describe('OpenAPI bounds equal the tenant_settings CHECKs of the first identity migration', () => {
  it('the CHECKs are idle 15..30 and absolute 1..12 (A8, REQ-SEC-073)', () => {
    expect(checkRange('tenant_settings__idle__ck', 'idle_timeout_minutes')).toEqual([15, 30]);
    expect(checkRange('tenant_settings__absolute__ck', 'absolute_session_hours')).toEqual([1, 12]);
  });
  it.each(SCHEMAS)('%s: minimum and maximum of both fields equal the CHECKs', (name) => {
    const props = spec.components.schemas[name].properties;
    expect([props.idle_timeout_minutes.minimum, props.idle_timeout_minutes.maximum]).toEqual(checkRange('tenant_settings__idle__ck', 'idle_timeout_minutes'));
    expect([props.absolute_session_hours.minimum, props.absolute_session_hours.maximum]).toEqual(checkRange('tenant_settings__absolute__ck', 'absolute_session_hours'));
  });
  it('no newer migration redefines the two tenant_settings checks (LD-306: none needed)', () => {
    const hits = readdirSync(DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f) && f > FIRST && /tenant_settings__(idle|absolute)__ck/.test(readFileSync(join(DIR, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
