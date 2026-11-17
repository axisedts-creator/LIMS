// C5 T-27 handler #17 getStatusBoard — contract + guards without a database (02-TRD §5.2 row 17; PRD AC-18.4; 07-SECURITY REQ-SEC-100, S-11, REQ-SEC-099 no stub).
// Fails now: handlers/index.ts maps getStatusBoard to the T-01 stub (common.internal). Behaviour against the migrated DB: statusBoard.handlers.integration.test.ts.
// Handler contract as in specimen.handlers.integration.test.ts: (req:{params,query,headers,body}, ctx) -> {status, body}; ctx = { tenantId, actor, tx, ports.IdentityPort.{assertRole,getActor}, ports.FrontdeskPort, ... }.
//   A ctx without tenantId/actor/tx -> auth.unauthenticated. The permission is lab.status_board.read (assertRole). Range / filter validation (S-11) happens BEFORE any query or port call;
//   the core pipeline also validates the schema, the handler re-checks (T-19 precedent) because it must not trust being reached only through the pipeline.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const S = spec.components.schemas;
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const DAY = 86_400_000;
const FROM = '2026-06-10T00:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(FROM) + ms).toISOString();

function ctxOf(o: { grants?: readonly string[]; forbid?: boolean } = {}) {
  const touched = { tx: vi.fn(), port: vi.fn(), roles: [] as any[] };
  const boom = (f: () => void) => async () => { f(); throw new Error('SENTINEL'); };
  const ctx = {
    operationId: 'getStatusBoard', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, requestId: 'r', now: () => new Date('2026-06-15T05:00:00Z'),
    tx: { query: boom(touched.tx) },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, x: any) { touched.roles.push(x); if (o.forbid || (o.grants && !o.grants.includes(x.permission))) throw new LimsError('auth.forbidden'); },
        async getActor() { return { centreScope: { all: false, centreIds: [CENTRE] } }; },
      },
      FrontdeskPort: { getPatientDemographicsBatch: boom(touched.port) },
    },
    events: { async publish() { return { eventId: 'e', duplicate: false }; } }, audit: { async access() {} },
  };
  return { ctx: ctx as never, touched };
}
const run = (q: unknown, c: unknown): Promise<any> => (handlers as any).getStatusBoard({ params: {}, query: q, headers: {}, body: undefined }, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

describe('T-27 contract of lab.yaml #17 getStatusBoard (the handler must fit it)', () => {
  const op = spec.paths['/v1/lab/status-board'].get;
  it('permission lab.status_board.read, no idempotency, registered_at_from required, board_status csv pattern', () => {
    expect(op).toMatchObject({ operationId: 'getStatusBoard', 'x-permission': 'lab.status_board.read', 'x-idempotency': 'none' });
    expect(op.parameters.find((p: any) => p.name === 'registered_at_from').required).toBe(true);
    expect(op.parameters.find((p: any) => p.name === 'registered_at_to').required).toBeFalsy();
    expect(new RegExp(op.parameters.find((p: any) => p.name === 'board_status').schema.pattern).test('ready,printed')).toBe(true);
    expect(new RegExp(op.parameters.find((p: any) => p.name === 'board_status').schema.pattern).test('ready,bogus')).toBe(false);
  });
  it('the row is a closed allowlist: board_status enum {collected,in_lab,ready,printed,waiting}; no tenant/PHI beyond PatientDisplay', () => {
    expect(S.StatusBoardRow.additionalProperties).toBe(false);
    expect(Object.keys(S.StatusBoardRow.properties).sort()).toEqual(['board_status', 'centre_id', 'last_released_at', 'order_id', 'patient_display', 'priority', 'registration_no', 'rejected_specimens']);
    expect(S.StatusBoardRow.properties.board_status.enum).toEqual(['collected', 'in_lab', 'ready', 'printed', 'waiting']);
    expect(S.StatusBoardPage.properties.data.maxItems).toBe(200);
  });
});

describe('T-27 getStatusBoard is a real handler, not the T-01 stub (REQ-SEC-099)', () => {
  it('ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.internal)', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    expect((await fail(run({ registered_at_from: FROM, registered_at_to: at(DAY) }, bare))).code).toBe('auth.unauthenticated');
  });

  it('a caller without lab.status_board.read gets auth.forbidden before any query or port call; assertRole is asked for exactly that permission', async () => {
    const { ctx, touched } = ctxOf({ grants: ['lab.specimen.read'] });
    const e = await fail(run({ registered_at_from: FROM, registered_at_to: at(DAY) }, ctx));
    expect(e.code).toBe('auth.forbidden');
    expect(touched.roles.map((r) => r.permission)).toContain('lab.status_board.read');
    expect(touched.tx).not.toHaveBeenCalled();
    expect(touched.port).not.toHaveBeenCalled();
  });
});

describe('T-27 S-11 / REQ-SEC-100 range and filter validation: common.validation_failed (400) before any query', () => {
  const GRANT = ['lab.status_board.read'];
  const cases: [string, Record<string, unknown>][] = [
    ['span 7 days + 1 s', { registered_at_from: FROM, registered_at_to: at(7 * DAY + 1000) }],
    ['span 30 days', { registered_at_from: FROM, registered_at_to: at(30 * DAY) }],
    ['registered_at_to before registered_at_from', { registered_at_from: FROM, registered_at_to: at(-DAY) }],
    ['registered_at_from missing', { registered_at_to: at(DAY) }],
    ['registered_at_from not a timestamp', { registered_at_from: 'yesterday', registered_at_to: at(DAY) }],
    ['board_status with an unknown value', { registered_at_from: FROM, registered_at_to: at(DAY), board_status: 'ready,bogus' }],
    ['board_status "reported" (not a board status)', { registered_at_from: FROM, registered_at_to: at(DAY), board_status: 'reported' }],
    ['centre_id not a uuid', { registered_at_from: FROM, registered_at_to: at(DAY), centre_id: 'not-a-uuid' }],
  ];
  for (const [name, q] of cases) {
    it(name, async () => {
      const { ctx, touched } = ctxOf({ grants: GRANT });
      const e = await fail(run(q, ctx));
      expect(e.code).toBe('common.validation_failed');
      expect(e.statusCode).toBe(400);
      expect(touched.tx).not.toHaveBeenCalled();
      expect(touched.port).not.toHaveBeenCalled();
    });
  }

  it('a span of exactly 7 days passes validation (the failure that follows comes from the stubbed tx, not from validation)', async () => {
    const { ctx, touched } = ctxOf({ grants: GRANT });
    const e = await fail(run({ registered_at_from: FROM, registered_at_to: at(7 * DAY) }, ctx));
    expect(e.code).not.toBe('common.validation_failed');
    expect(touched.tx.mock.calls.length + touched.port.mock.calls.length, 'the handler reads through ctx.tx').toBeGreaterThan(0);
  });
});
