// C16-T01 — module skeleton: manifest, permissions, boot, phase-stub replacement (06-PLAN row T-01; 02-TRD §3.2, §9.2, §9.3; 08 A17 P-20; AC US-EN-01.3).
// done_when: "manifest validates against EVENT_PRODUCERS; EngagementPort removed from phase-stubs.ts (paired C0-0D PR) and C16 impl registered
// returning exactly the stub results".
// SEAMS (spec does not fix them; same shape as smartreport/payments modules):
//   ../index.ts        export const manifest: ModuleManifest — name 'engagement', openapi 'contracts/openapi/engagement.yaml', a handler per operationId
//                      of engagement.yaml (stubs are fine; core validateManifest demands the exact set), produces = the two engagement.booking.* events,
//                      systemPermissions = TRD §9.3 (8 codes), authResolvers { patientPreAuth, queueDisplayToken } each with resolve() (core registry rule),
//                      ports.EngagementPort = the module's own implementation. 08 A17 P-20 / 06-PLAN T-01 (EngagementPort impl registered) override
//                      TRD §3.2 "ports: {}". `export const config = loadEngagementConfig()` at import (bad env stops the process).
//   ../permissions.ts  export const ENGAGEMENT_PERMISSIONS (frozen): every engagement.* code of contracts/permissions.yaml.
// Fails now: ../index.js, ../permissions.js, ../config.js do not exist; PHASE_STUBS still lists EngagementPort.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from '../../../../../../contracts/ports/generated/permissions.js';
import { eventProducers, loadSpec, operationIds, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { PHASE_STUBS, assertPhaseStubsCurrent, findStalePhaseStubs } from '../../../core/ports/phase-stubs.js';
import { manifest } from '../index.js';
import { ENGAGEMENT_PERMISSIONS } from '../permissions.js';

const SPEC = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'engagement.yaml'));
const OPS = operationIds(SPEC);
const EVENTS = ['engagement.booking.cancelled.v1', 'engagement.booking.confirmed.v1'];
const SYSTEM_PERMISSIONS = [ // TRD §9.3
  'engagement.bookable_item.manage', 'engagement.booking.cancel', 'engagement.booking.manage', 'engagement.link.read', 'engagement.link.revoke',
  'engagement.membership.enrol', 'engagement.reminder.manage', 'engagement.self.read',
];
const ENGAGEMENT_CODES = (PERMISSION_CODES as readonly string[]).filter((c) => c.startsWith('engagement.')).sort();

describe('C16-T01 manifest', () => {
  it('is module engagement bound to contracts/openapi/engagement.yaml and passes the core manifest validation', () => {
    expect(manifest.name).toBe('engagement');
    expect(manifest.openapi).toBe('contracts/openapi/engagement.yaml');
    expect(() => validateManifest('engagement', manifest, REPO_ROOT)).not.toThrow();
  });

  it('produces exactly EVENT_PRODUCERS.engagement (the two booking events)', () => {
    expect([...(eventProducers().engagement ?? [])].sort()).toEqual(EVENTS);
    expect([...manifest.produces].sort()).toEqual(EVENTS);
  });

  it('systemPermissions = TRD §9.3, each a real permission code', () => {
    expect([...(manifest.systemPermissions ?? [])].sort()).toEqual(SYSTEM_PERMISSIONS);
    for (const c of manifest.systemPermissions ?? []) expect(PERMISSION_CODES as readonly string[], c).toContain(c);
  });

  it('supplies authResolvers patientPreAuth and queueDisplayToken (CR-C16-005), each usable by the core registry (resolve())', () => {
    const r: any = manifest.authResolvers ?? {};
    expect(Object.keys(r).sort()).toEqual(['patientPreAuth', 'queueDisplayToken']);
    for (const k of Object.keys(r)) expect(typeof r[k].resolve, k).toBe('function');
    expect(manifest.claimsResolver).toBeUndefined(); // claimsResolver is identity-only
  });

  it('core boot validation rejects a drifted handler set (missing and extra operationId)', () => {
    const missing = OPS[0]!;
    const { [missing]: _drop, ...rest } = manifest.handlers;
    expect(() => validateManifest('engagement', { ...manifest, handlers: rest }, REPO_ROOT)).toThrow(missing);
    expect(() => validateManifest('engagement', { ...manifest, handlers: { ...manifest.handlers, notInSpec: manifest.handlers[missing]! } }, REPO_ROOT)).toThrow('notInSpec');
  });

  it('core boot validation rejects produces drift and a foreign auth resolver', () => {
    expect(() => validateManifest('engagement', { ...manifest, produces: [...EVENTS, 'lab.result.approved.v1'] }, REPO_ROOT)).toThrow(/produces/);
    expect(() => validateManifest('engagement', { ...manifest, produces: [] }, REPO_ROOT)).toThrow(/produces/);
    expect(() => validateManifest('engagement', { ...manifest, authResolvers: { ...manifest.authResolvers, portalSession: { resolve: async () => ({}) } } }, REPO_ROOT)).toThrow(/portalSession/);
  });
});

describe('C16-T01 handler map', () => {
  it('the spec has the 98 unique operationIds of the TRD §5 table', () => {
    expect(OPS.length).toBe(98);
    expect(new Set(OPS).size).toBe(98);
  });
  it('binds every operationId of engagement.yaml to a function, and nothing else', () => {
    expect(Object.keys(manifest.handlers).sort()).toEqual([...OPS].sort());
    for (const op of OPS) expect(typeof manifest.handlers[op], op).toBe('function');
  });
});

describe('C16-T01 permissions list', () => {
  it('ENGAGEMENT_PERMISSIONS is frozen and equals every engagement.* code of contracts/permissions.yaml', () => {
    expect(Object.isFrozen(ENGAGEMENT_PERMISSIONS)).toBe(true);
    expect([...ENGAGEMENT_PERMISSIONS].sort()).toEqual(ENGAGEMENT_CODES);
    expect(new Set(ENGAGEMENT_PERMISSIONS).size).toBe(ENGAGEMENT_PERMISSIONS.length);
  });
  it('contains the pre-auth and display codes of the two resolvers', () => {
    for (const c of ['engagement.auth.challenge', 'engagement.queue.board_read', 'engagement.link.redeem']) expect(ENGAGEMENT_PERMISSIONS).toContain(c);
  });
});

describe('C16-T01 phase-stub replacement (08 A17 P-20): the PR that creates modules/engagement removes EngagementPort from phase-stubs.ts', () => {
  it('PHASE_STUBS no longer lists EngagementPort and still lists QualityPort', () => {
    expect(PHASE_STUBS).not.toContain('EngagementPort');
    expect([...PHASE_STUBS]).toEqual(['QualityPort']);
  });
  it('AC-0D-6.3 gate: engagement/index.ts exists, so the port WOULD be stale if still listed; with the committed list nothing is stale', () => {
    expect(findStalePhaseStubs({ phaseStubs: ['EngagementPort'] })).toEqual([{ port: 'EngagementPort', owner: 'engagement' }]);
    expect(() => assertPhaseStubsCurrent({ phaseStubs: ['EngagementPort'] })).toThrow(/EngagementPort/);
    expect(findStalePhaseStubs()).toEqual([]);
    expect(() => assertPhaseStubsCurrent()).not.toThrow();
  });
});
