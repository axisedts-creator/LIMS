// T0B-DEPFIX-1 (LD-310, LD-312): source scan for real credential MATERIAL, not for variable NAMES.
// Fails on: PEM blocks, long quoted hex / base64 literals, JWT-shaped literals (service role keys), and a service-role / storage-key
// variable ASSIGNED a literal. Ignores a bare name such as LIMS_CORE_STORAGE_KEY_FILE (a name is not a secret; core/health.ts lists it).
const PEM = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----/;
const JWT_LITERAL = /['"`]eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}['"`]/;
const HEX_LITERAL = /['"`][0-9a-fA-F]{40,}['"`]/;
// 40+ chars of base64 / base64url that mix letters and digits (a path or an identifier has separators or no digits)
const B64_LITERAL = /['"`]([A-Za-z0-9+/_-]{40,}={0,2})['"`]/g;
const NAMED_ASSIGN = /(?:SERVICE_ROLE|STORAGE_SERVICE_KEY|STORAGE_KEY)[A-Z_]*['"`]?\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/g;
const ENV_NAME = /^[A-Z][A-Z0-9_]+$/; // a value that is itself a variable name (STORAGE_KEY_ENV = 'LIMS_CORE_STORAGE_KEY_FILE') is not a secret

export type CredentialHit = { kind: 'pem' | 'jwt' | 'hex' | 'base64' | 'named-assignment'; sample: string };

export function findCredentialMaterial(text: string): CredentialHit[] {
  const hits: CredentialHit[] = [];
  const add = (kind: CredentialHit['kind'], m: RegExpMatchArray | null) => { if (m) hits.push({ kind, sample: m[0].slice(0, 12) + '...' }); };
  add('pem', text.match(PEM));
  add('jwt', text.match(JWT_LITERAL));
  add('hex', text.match(HEX_LITERAL));
  for (const m of text.matchAll(NAMED_ASSIGN)) if (!ENV_NAME.test(m[1]!)) { hits.push({ kind: 'named-assignment', sample: m[0].slice(0, 12) + '...' }); break; }
  for (const m of text.matchAll(B64_LITERAL)) {
    const v = m[1]!;
    if (/[A-Za-z]/.test(v) && /\d/.test(v) && !/^[a-z]+(?:[-_][a-z0-9]+)+$/.test(v)) { hits.push({ kind: 'base64', sample: v.slice(0, 8) + '...' }); break; }
  }
  return hits;
}
