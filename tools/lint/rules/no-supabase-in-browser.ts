// 02-CONVENTIONS §1.3: no @supabase/supabase-js or @supabase/ssr in browser-bundled code (04 S4, REQ-SEC-068).
import { imports, under, type Violation } from './_scan.ts';

export const name = 'no-supabase-in-browser';
const BANNED = /^@supabase\/(supabase-js|ssr)(\/|$)/;
const BROWSER_APPS = ['apps/web', 'apps/portal', 'apps/partner'];

export function check(path: string, source: string): Violation[] {
  if (!BROWSER_APPS.some((d) => under(path, d))) return [];
  return imports(source)
    .filter(({ spec }) => BANNED.test(spec))
    .map(({ spec, line }) => ({ rule: name, line, message: `'${spec}' must not be imported in browser-bundled code; call the BFF` }));
}
