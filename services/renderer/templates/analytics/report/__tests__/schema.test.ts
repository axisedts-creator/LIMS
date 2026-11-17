// AN-T15b — analytics.report data schema (02-TRD §10.2 step 6a; C6 contract case (2) "data violating schema" with an invalid fixture). Synthetic data only.
// Two layers: (a) our fixtures against an inline transcription of the TRD schema (proves the fixtures are right, runs today);
//             (b) the same fixtures against contracts/render/analytics.report.schema.json (C0-0C deliverable; absent at the time of writing -> fails until it exists).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVALID, REPORT, clone, withRows, wideColumns } from './fixtures.js';

// ajv is not a renderer dependency: load the copy that services/api's @fastify/ajv-compiler ships (same trick as RenderPort.impl.ts).
const apiReq = createRequire(fileURLToPath(new URL('../../../../../api/package.json', import.meta.url)));
const Ajv2020 = createRequire(apiReq.resolve('@fastify/ajv-compiler'))('ajv/dist/2020.js').default as new (o: object) => { compile(s: object): (v: unknown) => boolean };
const compile = (schema: object) => new Ajv2020({ strict: false, allErrors: false }).compile(schema);

const str = { type: 'string', maxLength: 200 };
const TOP = ['tenantDisplayName', 'reportTitle', 'periodLabelAd', 'periodLabelBs', 'scopeLabel', 'generatedAtLocal', 'exportId', 'exportedBy', 'freshnessNote', 'notStatutoryNote'];
/** Inline transcription of 02-TRD §10.2 step 6a: all objects closed, every string <= 200, columns 1-40, rows 0-5,000, cells string | integer. */
const TRD_SCHEMA = {
  type: 'object', additionalProperties: false, required: [...TOP, 'columns', 'rows'],
  properties: {
    ...Object.fromEntries(TOP.map((k) => [k, str])),
    columns: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['key', 'label', 'kind'],
      properties: { key: { type: 'string', pattern: '^[a-z0-9_]{1,40}$' }, label: str, kind: { enum: ['text', 'count', 'paisa', 'seconds', 'bp'] } } } },
    rows: { type: 'array', maxItems: 5000, items: { type: 'object', additionalProperties: { anyOf: [str, { type: 'integer' }] } } },
  },
};

const VALID: [string, unknown][] = [
  ['the sample report', REPORT], ['0 rows', { ...clone(REPORT), rows: [] }], ['40 columns', withRows(2, wideColumns(40))],
  ['5,000 rows', withRows(5000)], ['200-char strings', { ...clone(REPORT), reportTitle: 'x'.repeat(200) }],
];

describe('fixtures vs the TRD §10.2 step 6a schema (inline transcription)', () => {
  const ok = compile(TRD_SCHEMA);
  it.each(VALID)('valid: %s', (_n, d) => { expect(ok(d)).toBe(true); });
  it.each(INVALID)('invalid: %s', (_n, d) => { expect(ok(d)).toBe(false); });
});

describe('contracts/render/analytics.report.schema.json (C0-0C transcription of step 6a)', () => {
  const file = fileURLToPath(new URL('../../../../../../contracts/render/analytics.report.schema.json', import.meta.url));
  it('exists (C0-0C deliverable; RenderPort validates analytics.report data against it before calling the renderer)', () => {
    expect(existsSync(file)).toBe(true);
  });
  const load = () => compile(JSON.parse(readFileSync(file, 'utf8')) as object);
  it.each(VALID)('accepts: %s', (_n, d) => { expect(load()(d)).toBe(true); });
  it.each(INVALID)('rejects (reporting.template_invalid at RenderPort): %s', (_n, d) => { expect(load()(d)).toBe(false); });
});
