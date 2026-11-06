// 02-TRD §3.2 / AC-0A-3.4: BS-date libraries only behind the bsdate wrapper.
import { imports, under, type Violation } from './_scan.ts';

export const name = 'no-raw-bs-lib';
const ALLOWED = ['packages/shared-ts/src/bsdate', 'packages/shared-dart/lib/src/bsdate'];
const BANNED = /^(@remotemerge\/nepali-date-converter|bikram-sambat)(\/|$)|^package:nepali_utils\//;

export function check(path: string, source: string): Violation[] {
  if (ALLOWED.some((d) => under(path, d))) return [];
  return imports(source)
    .filter(({ spec }) => BANNED.test(spec))
    .map(({ spec, line }) => ({ rule: name, line, message: `import '${spec}' only inside the bsdate wrapper (@lims/shared-ts/bsdate, lims_shared lib/src/bsdate/)` }));
}
