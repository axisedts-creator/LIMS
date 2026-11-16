// T0B-SWEEP-1 / LD-269 SAFETY: the harness refuses a non-local database. Implementation: services/api/test-sweep/safety.ts
// export function assertLocalDatabase(urlOrHost: string): void   // throws Error on anything but localhost, 127.0.0.1, ::1, or a Docker-network address (172.16.0.0/12)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLocalDatabase } from '../safety.js';

describe('harness refuses a non-local database host', () => {
  it.each([
    'localhost', '127.0.0.1', 'postgres://u:p@localhost:5432/postgres', 'postgres://u@127.0.0.1:55432/postgres',
    'postgres://u@[::1]:5432/postgres', 'postgres://u@172.17.0.2:5432/postgres',
  ])('accepts %s', (v) => { expect(() => assertLocalDatabase(v)).not.toThrow(); });

  it.each([
    'db.abcdefgh.supabase.co', 'postgres://u:p@db.abcdefgh.supabase.co:5432/postgres', '8.8.8.8', 'postgres://u@10.0.0.5:5432/x',
    'postgres://u@192.168.1.10:5432/x', 'localhost.evil.example.com', 'postgres://localhost@evil.example.com:5432/x',
    'postgres://u@172.32.0.1:5432/x', '', 'postgres:///postgres',
  ])('refuses %s', (v) => { expect(() => assertLocalDatabase(v)).toThrow(); });

  it('harness sources never reference the cloud secrets folder outside comments', () => {
    const dir = join(import.meta.dirname, '..');
    const files = readdirSync(dir).filter((f) => /\.(ts|mjs|js)$/.test(f) && statSync(join(dir, f)).isFile());
    expect(files).toContain('safety.ts'); // fails now: harness not written
    for (const f of files) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        expect(line, `${f}: ${line}`).not.toMatch(/LIMS-cloud-secrets/i);
      }
    }
  });
});
