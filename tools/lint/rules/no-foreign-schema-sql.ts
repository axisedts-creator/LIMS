// 02-TRD: SQL mentioning `core.` only in services/api/src/core/** and services/api/src/modules/identity/repository/**
// (CR-C2-002); core.dead_letters only in services/api/src/core/** (08 A8.6, 07-SECURITY AB-21).
import { lineAt, normPath, sqlTexts, type Violation } from './_scan.ts';

export const name = 'no-foreign-schema-sql';
const CORE_DIR = 'services/api/src/core/';
const IDENTITY_REPO = 'services/api/src/modules/identity/repository/';
// `${` = interpolated table name; could be dead_letters, so treated like it (flagged in identity/repository too).
const CORE_REF = /(?<![\w$.])"?core"?\s*\.\s*"?([a-z_][a-z0-9_$]*|\$\{)"?/gi;

export function check(path: string, source: string): Violation[] {
  const p = normPath(path);
  if (p.startsWith(CORE_DIR)) return [];
  const repo = p.startsWith(IDENTITY_REPO);
  const out: Violation[] = [];
  for (const { value, offset } of sqlTexts(p, source)) {
    for (const m of value.matchAll(CORE_REF)) {
      const table = m[1].toLowerCase();
      const dynamic = table === '${';
      if (repo && table !== 'dead_letters' && !dynamic) continue;
      const line = lineAt(source, offset + m.index);
      if (out.some((v) => v.line === line)) continue;
      out.push({
        rule: name,
        line,
        message: dynamic
          ? 'SQL with an interpolated core.<table> name is allowed only in services/api/src/core/**; name the table literally'
          : table === 'dead_letters'
          ? 'SQL naming core.dead_letters is allowed only in services/api/src/core/**; use ctx.core.deadLetters (08 A8.6)'
          : `SQL naming core.${table} is allowed only in services/api/src/core/** and modules/identity/repository/**`,
      });
    }
  }
  return out;
}
