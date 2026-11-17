// mapping.md is a deliverable (plan T1 done_when). Required format (the writer must follow it):
//   - first lines state the pinned version `v2.197.0` (infra/compose/supabase/upstream/docker-compose.yml) and a line
//     `Live contract run: PASS <YYYY-MM-DD>` once http.live.test.ts passed against the container.
//   - one section per gateway method:  `### <methodName>`  containing the bullets
//        - Request: <GET|POST|PUT|PATCH|DELETE> /<path>        - Headers: …      - Request fields: …
//        - Response fields: …      - Env: <GOTRUE_… / LIMS_IDENTITY_… names, or `none`>      - Source: https://… (pinned source/docs)
//   - a `## Verdicts` section with one line per key:  `- KEY: CONFIRMED — evidence`  or  `- KEY: REFUTED — evidence`
//     keys = VERDICT_KEYS in helpers.ts. REFUTED items need a CR file in .orchestra/cr/ (see below).
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CR_DIR, PINNED_VERSION, VERDICT_KEYS, readMapping, readVerdicts } from './helpers.js';

const METHODS = [
  'signInWithPassword', 'refresh', 'signOut', 'adminCreateUser', 'adminUpdatePassword', 'adminSignOutUser', 'adminFindUserByEmail',
  'adminDeleteFactor', 'sendInvite', 'sendRecovery', 'verifyEmailToken', 'mfaEnrollTotp', 'mfaChallengeAndVerify', 'mfaListFactors',
] as const;

const section = (md: string, name: string): string | undefined => {
  const m = new RegExp(`^###\\s+\`?${name}\`?\\s*$([\\s\\S]*?)(?=^#{1,3}\\s|(?![\\s\\S]))`, 'm').exec(md);
  return m?.[1];
};
const crText = (): string => (existsSync(CR_DIR) ? readdirSync(CR_DIR).filter((f) => f.endsWith('.md')).map((f) => readFileSync(resolve(CR_DIR, f), 'utf8')).join('\n') : '');

describe('mapping.md', () => {
  it('exists and names the pinned GoTrue version and a passing live contract run', () => {
    const md = readMapping();
    expect(md).toContain(PINNED_VERSION);
    expect(md).toMatch(/^Live contract run:\s*PASS\s+\d{4}-\d{2}-\d{2}/m);
  });
  it.each(METHODS)('%s: exact HTTP method+path, headers, request/response fields, env, source link', (m) => {
    const s = section(readMapping(), m);
    expect(s, `missing "### ${m}" section`).toBeDefined();
    expect(s).toMatch(/^\s*[-*]\s*Request:\s*(GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_\-/{}?=&.]+/m);
    expect(s).toMatch(/^\s*[-*]\s*Headers:\s*\S+/m);
    expect(s).toMatch(/^\s*[-*]\s*Request fields:\s*\S+/m);
    expect(s).toMatch(/^\s*[-*]\s*Response fields:\s*\S+/m);
    expect(s).toMatch(/^\s*[-*]\s*Env:\s*\S+/m);
    expect(s).toMatch(/^\s*[-*]\s*Source:\s*\[?[^\s\]]*https?:\/\/\S+/m);
  });
  it('has a verdict (CONFIRMED|REFUTED) for every checklist item', () => {
    const v = readVerdicts();
    for (const k of VERDICT_KEYS) expect(v[k], `verdict ${k}`).toBeDefined();
  });
  it('documents the env keys the config needs (min password length, link TTL, refresh reuse interval, rotation)', () => {
    const md = readMapping();
    for (const re of [/GOTRUE_PASSWORD_MIN_LENGTH/, /GOTRUE_MAILER_OTP_EXP/, /GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED/, /GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL/, /LIMS_IDENTITY_GOTRUE_URL/, /LIMS_IDENTITY_GOTRUE_SERVICE_KEY/])
      expect(md).toMatch(re);
  });

  describe('release preconditions (08 A25 D-218, D-219, A25.2)', () => {
    it('LINK_TTL_LE_60MIN REFUTED ⇒ a CR in .orchestra/cr/ proposes identity.recovery_requests', () => {
      if (readVerdicts().LINK_TTL_LE_60MIN === 'REFUTED') expect(crText()).toContain('identity.recovery_requests');
    });
    it('patient kind: not (a AND b CONFIRMED) ⇒ mapping says the patient session kind stays BLOCKED', () => {
      const v = readVerdicts(); const md = readMapping();
      const both = v.D218_A_CREATE_WITHOUT_EMAIL === 'CONFIRMED' && v.D218_B_CREDENTIALLESS_SESSION === 'CONFIRMED';
      if (both) expect(md).toMatch(/patient[^\n]*(UNBLOCKED|unblocked)/i);
      else expect(md).toMatch(/patient[^\n]*BLOCKED/);
    });
    it('both D-218 items REFUTED ⇒ CR to 08 R10 (LIMS-issued patient JWT) addressed to lead and founder', () => {
      const v = readVerdicts();
      if (v.D218_A_CREATE_WITHOUT_EMAIL === 'REFUTED' && v.D218_B_CREDENTIALLESS_SESSION === 'REFUTED') {
        const cr = crText();
        expect(cr).toMatch(/R10/); expect(cr).toMatch(/lead/i); expect(cr).toMatch(/founder/i);
      }
    });
    it('any other REFUTED item ⇒ a CR (to C1) exists or 02-TRD s8 redesign note is referenced in mapping.md', () => {
      const v = readVerdicts(); const md = readMapping();
      const others = VERDICT_KEYS.filter((k) => v[k] === 'REFUTED' && !['LINK_TTL_LE_60MIN', 'D218_A_CREATE_WITHOUT_EMAIL', 'D218_B_CREDENTIALLESS_SESSION'].includes(k));
      for (const k of others) expect(crText().includes(k) || new RegExp(`${k}[^\\n]*(02-TRD|redesign)`).test(md), `${k} needs a CR or redesign note`).toBe(true);
    });
  });
});
