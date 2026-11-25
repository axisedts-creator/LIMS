// Shared cases (packages/test-fixtures/homecollection/mutation-payload-cases.json) for validateMutationPayload.
// The phlebo app runs the SAME file against its mirror (apps/phlebo_app/__tests__/mutation_payload_shared_cases_test.dart):
// a schema change that is made on one side only fails one of the two suites.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTATION_TYPES, validateMutationPayload } from '../../domain/mutation.js';

type Case = { name: string; type: string; payload: unknown; valid: boolean };
const file = new URL('../../../../../../../packages/test-fixtures/homecollection/mutation-payload-cases.json', import.meta.url);
const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] };

describe('mutation payload shared cases', () => {
  it('cover every mutation type with a valid and an invalid case', () => {
    for (const t of MUTATION_TYPES) {
      expect(cases.some((c) => c.type === t && c.valid), `${t} valid`).toBe(true);
      expect(cases.some((c) => c.type === t && !c.valid), `${t} invalid`).toBe(true);
    }
  });
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => expect(validateMutationPayload(c.type, c.payload).ok).toBe(c.valid));
});
