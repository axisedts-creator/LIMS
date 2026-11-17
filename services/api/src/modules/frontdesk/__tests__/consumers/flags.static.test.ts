// FD-T12 review item 1, static/contract checks (no database): F12 confirmPreRegisteredOrder, F22 listOrderFlags, F23 resolveOrderFlag are real handlers (not `notImplemented`) with the TRD §5.1 contract.
// LD-70: removing the three operationIds from probes/pending.json is the WRITER's job and is deliberately not asserted here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const code = (rel: string) => text(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const op = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const NAMES = ['confirmPreRegisteredOrder', 'listOrderFlags', 'resolveOrderFlag'] as const;

describe('FD-T12 desk operations are wired as real handlers', () => {
  it('handler files and service/flags.service.ts exist', () => {
    for (const n of NAMES) expect(existsSync(join(REPO_ROOT, `${F}/handlers/${n}.ts`)), n).toBe(true);
    expect(existsSync(join(REPO_ROOT, `${F}/service/flags.service.ts`))).toBe(true);
  });
  it.each([
    ['confirmPreRegisteredOrder', () => import('../../handlers/confirmPreRegisteredOrder.js')],
    ['listOrderFlags', () => import('../../handlers/listOrderFlags.js')],
    ['resolveOrderFlag', () => import('../../handlers/resolveOrderFlag.js')],
  ])('handlers/%s.ts exports `handler` and index.ts maps the operation to it (not the notImplemented stub)', async (name, load) => {
    const m = await load();
    expect(m.handler).toBeTypeOf('function');
    const idx = await import('../../handlers/index.js');
    expect((idx.handlers as any)[name]).toBe(m.handler);
  }, 60_000);
  it('F22/F23 live in service/flags.service.ts; the handlers are thin (no repository import)', () => {
    for (const n of ['listOrderFlags', 'resolveOrderFlag']) {
      const src = text(`${F}/handlers/${n}.ts`);
      expect(src, n).toMatch(/flags\.service/);
      expect(src, n).not.toMatch(/repository\//);
    }
  });
  it('flags.service reads the clock from ctx.now(), never Date.now()/new Date()', () => {
    expect(code(`${F}/service/flags.service.ts`)).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
});

describe('FD-T12 desk operations contract (02-TRD §5.1)', () => {
  it('F12: frontdesk.registration.create, Idempotency-Key required, If-Match, declares common.immutable_record + the F9 registration errors', () => {
    const o = op('confirmPreRegisteredOrder');
    expect(o['x-permission']).toBe('frontdesk.registration.create');
    expect(o['x-idempotency']).toBe('required');
    expect(o['x-error-codes']).toEqual(expect.arrayContaining(['common.immutable_record', 'common.version_conflict', 'frontdesk.consent_required', 'billing.payment_exceeds_due', 'billing.counter_busy', 'catalog.no_price']));
    expect(JSON.stringify(o.parameters)).toMatch(/IfMatch/);
  });
  it('F22: frontdesk.order.read, no idempotency, filters status (open|resolved, default open) / kind / centre_id + cursor/limit', () => {
    const o = op('listOrderFlags');
    expect(o['x-permission']).toBe('frontdesk.order.read');
    expect(o['x-idempotency']).toBe('none');
    const p = (n: string) => o.parameters.find((x: any) => x.name === n);
    expect(p('status').schema.enum).toEqual(['open', 'resolved']);
    expect(p('status').schema.default).toBe('open');
    expect(p('kind').schema.enum).toEqual(['recollection_required', 'booking_cancelled_after_registration']);
    expect(p('centre_id')).toBeDefined();
  });
  it('F23: frontdesk.order.edit, Idempotency-Key required, If-Match, declares common.immutable_record; body {resolution_code, note<=500}', () => {
    const o = op('resolveOrderFlag');
    expect(o['x-permission']).toBe('frontdesk.order.edit');
    expect(o['x-idempotency']).toBe('required');
    expect(o['x-error-codes']).toContain('common.immutable_record');
    expect(JSON.stringify(o.parameters)).toMatch(/IfMatch/);
    const s = spec.components.schemas.ResolveOrderFlagRequest;
    expect(s.required).toContain('resolution_code');
    expect(s.properties.note.maxLength).toBe(500);
  });
});
