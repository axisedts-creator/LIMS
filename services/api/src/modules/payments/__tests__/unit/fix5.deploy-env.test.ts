// T0D-FIX-5, LD-447 done_when (5) + LD-449 (c): the repo deploy template that lists the web environment (infra/compose/lims/compose.app.yml; there is no render.yaml) carries
// LIMS_PAYMENTS_GATEWAY_ENV as ONE shared value for web, api and worker: exactly uat for the demo tenant, never production. Today only the web block has it.
// Reads the compose file as data (anchors and merge keys resolved); touches no secret file.
// Fails now: api-a, api-b and worker-a resolve to no LIMS_PAYMENTS_GATEWAY_ENV.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';

const FILE = join(REPO_ROOT, 'infra', 'compose', 'lims', 'compose.app.yml');
const text = readFileSync(FILE, 'utf8');
const doc: any = parse(text, { merge: true });
const KEY = 'LIMS_PAYMENTS_GATEWAY_ENV';
const envOf = (svc: string): Record<string, unknown> => {
  const e = doc.services?.[svc]?.environment;
  if (Array.isArray(e)) return Object.fromEntries(e.map((x: string) => x.split(/=(.*)/s).slice(0, 2)));
  return e ?? {};
};
const SERVICES = ['web-a', 'web-b', 'api-a', 'api-b', 'worker-a', 'worker-b'];

describe('compose.app.yml: LIMS_PAYMENTS_GATEWAY_ENV', () => {
  it.each(SERVICES)('%s resolves LIMS_PAYMENTS_GATEWAY_ENV to exactly "uat"', (svc) => {
    expect(doc.services?.[svc], `${svc} exists in the template`).toBeTruthy();
    expect(envOf(svc)[KEY]).toBe('uat');
  });
  it('one shared value: web, api and worker resolve to the same single value', () => {
    expect(new Set(SERVICES.map((s) => envOf(s)[KEY]))).toEqual(new Set(['uat']));
  });
  it('the template defines the literal at most once (the rest are YAML aliases), so the three can never drift apart', () => {
    const literal = text.split(/\r?\n/).filter((l) => new RegExp(`^\\s*${KEY}:\\s*(?!\\*)(?!&\\w+\\s*$)\\S`).test(l) && !l.trim().startsWith('#'));
    expect(literal.length, JSON.stringify(literal)).toBeLessThanOrEqual(1);
  });
  it('"production" is never assigned to it anywhere in the template', () => {
    expect(text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#') && new RegExp(`${KEY}\\s*[:=]\\s*"?production`).test(l))).toEqual([]);
  });
  it('the template holds no secret value for the payments gateway (only file paths)', () => {
    expect(text).not.toMatch(/(sk_(live|test)_|secret_key\s*:\s*\S{8,})/i);
  });
});
