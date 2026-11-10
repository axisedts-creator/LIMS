// J-T01 gate (US-FD-03.5). The full FD integration suite (real BillingCommandPort, failure injected after issueOrderInvoice,
// counter rolled back, next invoice reuses the number) needs FD-T06 `service/registration.service.ts#createRegistration` (02-TRD §2 file map).
// That file is absent in this tree, so the suite cannot be written without inventing its signature. This gate fails until FD-T06 lands;
// the tester then replaces/extends it with the rollback test. See .orchestra/notes/J-T01-tests.md.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const fd = join(here, '..', '..');
const billing = join(fd, '..', 'billing');

describe('J-T01 prerequisites: FD registration over the real billing port', () => {
  it('FD-T06 registration.service.ts exists and exports createRegistration', () => {
    const f = join(fd, 'service', 'registration.service.ts');
    expect(existsSync(f), 'FD-T06 not merged: frontdesk/service/registration.service.ts missing').toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/export\s+(async\s+)?(function|const)\s+createRegistration|createRegistration\s*[,}]/);
  });

  it('BL-T07 real BillingCommandPort implementation exists', () => {
    expect(existsSync(join(billing, 'ports', 'BillingCommandPort.impl.ts'))).toBe(true);
  });
});
