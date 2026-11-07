// T0D-01 / LD-53 (1): spec loader alias collision (CR-C2-020, option A).
// A local node that is exactly `{ $ref: <same file + JSON pointer being placed> }` is an alias of the very target being
// bundled: it must be replaced by the cloned target, not reported as a collision. Every other collision still throws.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../module.js';
import { FIXTURES } from './helpers.js';

const L = join(FIXTURES, 'loader');
const load = (f: string) => loadSpec(join(L, f));
const BFF = { type: 'apiKey', in: 'header', name: 'X-Lims-Bff-Key' };

describe('loadSpec: alias of the bundled target (LD-53, CR-C2-020)', () => {
  it('alias after paths (identity.yaml layout) is replaced by the cloned target, with no $ref left', () => {
    const spec = load('alias-last.yaml');
    expect(spec.components.securitySchemes.bffSession).toEqual(BFF);
    expect(spec.components.responses.Err).toEqual({ description: 'error' }); // other refs still bundled
    expect(spec.paths['/v1/x'].get.responses['401']).toEqual({ $ref: '#/components/responses/Err' });
  });

  it('another ref to the same target visited before the alias is still bundled and the alias is replaced', () => {
    const spec = load('alias-after-ref.yaml');
    expect(spec.components.securitySchemes.bffSession).toEqual(BFF);
    expect(spec.paths['/v1/x'].get.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/securitySchemes/bffSession' });
  });

  it('the result holds no cross-file $ref', () => {
    for (const f of ['alias-last.yaml', 'alias-after-ref.yaml']) {
      expect(JSON.stringify(load(f))).not.toMatch(/\.yaml#/);
    }
  });

  it('the real contracts/openapi/identity.yaml (alias at components.securitySchemes.bffSession) loads', () => {
    const spec = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
    const common = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', '_common.yaml'));
    expect(spec.components.securitySchemes.bffSession.$ref).toBeUndefined();
    expect(spec.components.securitySchemes.bffSession).toEqual(common.components.securitySchemes.bffSession);
  });
});

describe('loadSpec: every other collision still throws (LD-53)', () => {
  it('a genuinely different local definition of the same name throws', () => {
    expect(() => load('local-different.yaml')).toThrow(/collides with a local definition/);
  });

  it('a local node with sibling keys next to the $ref is not an exact alias and throws', () => {
    expect(() => load('alias-siblings.yaml')).toThrow(/collid/);
  });

  it('a local alias of one file plus a ref to the same pointer in another file throws', () => {
    expect(() => load('alias-other-file.yaml')).toThrow(/collides with/);
  });
});
