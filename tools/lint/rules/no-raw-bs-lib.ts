// 02-TRD §3.2 / AC-0A-3.4: BS-date libraries only behind the bsdate wrapper.
import { imports, normPath, under, type Violation } from './_scan.ts';

export const name = 'no-raw-bs-lib';
const ALLOWED = ['packages/shared-ts/src/bsdate', 'packages/shared-dart/lib/src/bsdate'];
const BANNED = /^(@remotemerge\/nepali-date-converter|bikram-sambat)(\/|$)|^package:nepali_utils\//;
// bikram-sambat may appear only as a test oracle (02-TRD l.97, 02-CONVENTIONS); the other libs stay banned in tests.
const ORACLE = /^bikram-sambat(\/|$)/;
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[^/]+$/;

export function check(path: string, source: string): Violation[] {
  if (ALLOWED.some((d) => under(path, d))) return [];
  const isTest = TEST_FILE.test(normPath(path));
  return imports(source)
    .filter(({ spec }) => BANNED.test(spec) && !(isTest && ORACLE.test(spec)))
    .map(({ spec, line }) => ({ rule: name, line, message: `import '${spec}' only inside the bsdate wrapper (@lims/shared-ts/bsdate, lims_shared lib/src/bsdate/)` }));
}
