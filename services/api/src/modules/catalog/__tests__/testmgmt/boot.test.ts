// T0B-TESTMGMT-1 done_when (1) + (4) + (5), static (no database): the module boot check passes with REAL handlers for the three category operations of T0C-TESTMGMT-1
// (no pendingOperations left in catalog), and the contract keeps the clinical sign-off model: publish permission untouched, no clinical field on a display-only update
// schema, no DELETE verb for categories or notes (deactivate, never delete).
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, checkHandlers, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const NEW_OPS = ['listTestCategories', 'createTestCategory', 'updateTestCategory'] as const;
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const pending = ((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? []) as readonly string[];

describe('(1) module boot: every operation of catalog.yaml has a real handler', () => {
  it('the three category operations have a handler in the manifest', () => {
    for (const id of NEW_OPS) { expect(typeof (manifest.handlers as any)[id], id).toBe('function'); expect((manifest.handlers as any)[id], id).toBe((handlers as any)[id]); }
  });
  it('catalog lists NO pending operation any more (T0B removes the ids it implements, LD-325 b)', () => {
    expect(pending).toEqual([]);
  });
  it('checkHandlers (the boot check, AC-0D-1.2) passes with handlers only and reports no stale pending id', () => {
    expect(checkHandlers('catalog', spec, manifest.handlers, [])).toEqual([]);
    expect(checkHandlers('catalog', spec, manifest.handlers, pending)).toEqual([]);
  });
  it('the contract still has exactly the 110 operations (this task adds handlers, not operations)', () => {
    expect(operationIds(spec)).toHaveLength(110);
    expect(Object.keys(manifest.handlers).sort()).toEqual(operationIds(spec).sort());
  });
});

describe('contract guards of the task (permissions, closed schemas, no delete)', () => {
  it('category operations: reads catalog.test.read, writes catalog.test.manage; create needs an Idempotency-Key, update an If-Match', () => {
    expect(opOf('listTestCategories')['x-permission']).toBe('catalog.test.read');
    expect(opOf('createTestCategory')['x-permission']).toBe('catalog.test.manage');
    expect(opOf('createTestCategory')['x-idempotency']).toBe('required');
    expect(opOf('updateTestCategory')['x-permission']).toBe('catalog.test.manage');
    expect(JSON.stringify(opOf('updateTestCategory').parameters)).toContain('IfMatch');
  });
  it('done_when (4): the publish operations keep catalog.reference_range.publish; drafts keep catalog.test.manage', () => {
    for (const id of ['publishAnalyteVersion', 'publishReferenceRangeSet', 'publishCriticalLimitSet', 'retireReferenceRangeSet', 'retireCriticalLimitSet']) expect(opOf(id)['x-permission'], id).toBe('catalog.reference_range.publish');
    for (const id of ['createAnalyteVersionDraft', 'updateAnalyteVersionDraft', 'replaceReferenceRangeSetBands', 'replaceCriticalLimitSetBands', 'updateAnalyte', 'updateTest']) expect(opOf(id)['x-permission'], id).toBe('catalog.test.manage');
  });
  it('done_when (4): the in-place (display only) update schemas carry NO field that changes what a result means', () => {
    const CLINICAL = ['result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'default_value', 'long_text_value', 'high_low', 'require_verification',
      'low', 'high', 'bands', 'age_low', 'age_high', 'auto_approved_low', 'auto_approved_high', 'default_range'];
    for (const n of ['AnalyteUpdate', 'TestUpdate', 'PanelUpdate', 'TestCategoryUpdate']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of CLINICAL) expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
    }
  });
  it('done_when (5): no DELETE verb on categories, notes (comment codes) or any catalog path touched by this task', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      if (/test-categories|comment-codes|\/tests|\/analytes|\/panels|range-sets|critical-limit/.test(path)) expect(Object.keys(item), path).not.toContain('delete');
    }
  });
  it('the three category operations are strict on the wire (closed bodies, no server owned field)', () => {
    for (const n of ['TestCategoryCreate', 'TestCategoryUpdate']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of ['id', 'tenant_id', 'version', 'created_by', 'updated_by']) expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
    }
  });
});
