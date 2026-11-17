// X-Lims-Bff-Key -> BFF kind (08 R10, A13 D-32, A19 P-45). One key per line; several lines/files = rotation overlap.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const BFF_KINDS = ['staff_web', 'partner', 'portal'] as const;
export type BffKind = (typeof BFF_KINDS)[number];
export type BffKeyFiles = Partial<Record<BffKind, readonly string[]>>;

export interface BffKeyVerifier {
  /** Never throws; undefined = absent or not a valid key. */
  verify(header: unknown): BffKind | undefined;
  /** Re-reads the key files (rotation). Throws and keeps the current keys if a file is unreadable. */
  reload(): void;
}

const MAX_KEY = 4096; // [CONV]
// Compare fixed-length digests so timingSafeEqual never sees different lengths and timing leaks no key length.
const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export function createBffKeyVerifier(files: BffKeyFiles): BffKeyVerifier {
  let keys: ReadonlyArray<readonly [BffKind, Buffer]> = [];
  const load = () => {
    const out: Array<readonly [BffKind, Buffer]> = [];
    for (const kind of BFF_KINDS) {
      for (const f of files[kind] ?? []) {
        let text: string;
        try {
          text = readFileSync(f, 'utf8');
        } catch {
          throw new Error(`bff-key: key file for kind ${kind} is unreadable: ${f}`); // path only, never key material
        }
        for (const line of text.split(/\r?\n/)) {
          const k = line.trim();
          if (k) out.push([kind, digest(k)]);
        }
      }
    }
    keys = out;
  };
  load();
  return {
    verify(header) {
      if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY) return undefined;
      const d = digest(header);
      let kind: BffKind | undefined;
      for (const [k, key] of keys) if (timingSafeEqual(d, key) && !kind) kind = k; // no early exit
      return kind;
    },
    reload: load,
  };
}
