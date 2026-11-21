// T0D-UIGUARD-1-PARTNERS (tester-owned). LD-353 rule 2, LD-436/LD-439 rule 7 on every partners component file. Source-level: display only, no data change.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handBuiltFilterRow, rawStructureViolations } from '@/core/__tests__/uiguard1.helpers';

const DIR = join(process.cwd(), 'src/features/partners/components'); // vitest root = apps/web
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.tsx'));
const src = (f: string) => readFileSync(join(DIR, f), 'utf8');

describe('rule 2: FilterBar on the partners list screens', () => {
  for (const f of ['PartysetCommon.tsx', 'ManifestInbox.tsx', 'PenaltyEvents.tsx', 'TicketInbox.tsx']) {
    it(`${f} imports and renders the kit FilterBar and builds no filter row by hand`, () => {
      const s = src(f);
      expect(/import\s*\{[^}]*\bFilterBar\b[^}]*\}\s*from\s*'@lims\/ui\/components\/FilterBar'/.test(s), 'FilterBar import').toBe(true);
      expect(/<FilterBar\b/.test(s), '<FilterBar rendered').toBe(true);
      expect(handBuiltFilterRow(s), 'hand built filter row').toBe(false);
    });
  }
});

describe('rule 7: no raw h1 to h4, no raw ul or ol for page structure in any partners component', () => {
  for (const f of FILES) it(f, () => expect(rawStructureViolations(src(f)), f).toEqual([]));
});
