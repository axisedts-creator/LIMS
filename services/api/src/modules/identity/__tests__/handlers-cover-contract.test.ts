// RM-T05 / LD-158: boot break guard. Every operationId in contracts/openapi/identity.yaml must have a function handler in the
// identity module (and no handler may lack an operationId), else module boot fails with "missing handler for operationId X".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkHandlers, operationIds } from '../../../core/module.js';
import { handlers } from '../handlers/index.js';

const root = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec = parse(readFileSync(join(root, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
const ids = operationIds(spec);

describe('identity handlers cover contracts/openapi/identity.yaml (LD-158)', () => {
  it('the spec declares the CR-C2-RM-001 operations', () => {
    expect(ids).toContain('listRolePacks');
    expect(ids).toContain('applyRolePack');
  });

  it.each(ids)('operationId %s has a handler function', (op) => {
    expect(Object.hasOwn(handlers, op), `missing handler for operationId ${op}`).toBe(true);
    expect(typeof (handlers as Record<string, unknown>)[op]).toBe('function');
  });

  it('every handler key is an operationId of the spec (no extras)', () => {
    const set = new Set(ids);
    expect(Object.keys(handlers).filter((k) => !set.has(k))).toEqual([]);
  });

  it('core checkHandlers (the boot validation) accepts the identity handlers', () => {
    expect(() => checkHandlers('identity', spec, handlers)).not.toThrow();
  });
});
