// T0D-11 / AC-0D-9.1 + done_when "Dart tokens generated".
// Runs scripts/build-tokens.ts (Node >= 22.18 strips types natively; script must run via `node <file>` with no args).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dart = join(ui, '..', 'ui-flutter', 'lib', 'src', 'tokens.g.dart');
const css = join(ui, 'dist', 'tokens.css');
const ts = join(ui, 'src', 'tokens.ts');
const run = () => execFileSync(process.execPath, [join(ui, 'scripts', 'build-tokens.ts')], { cwd: ui, encoding: 'utf8' });

describe('build-tokens', () => {
  it('committed tokens.g.dart exists (AC-0D-9.1)', () => {
    expect(existsSync(dart)).toBe(true);
  });

  it('regenerated tokens.g.dart equals the committed file; idempotent (AC-0D-9.1)', () => {
    const committed = readFileSync(dart, 'utf8');
    run();
    const first = readFileSync(dart, 'utf8');
    run();
    expect(first).toBe(committed);
    expect(readFileSync(dart, 'utf8')).toBe(first);
  });

  it('emits dist/tokens.css with --lims-accent custom properties and src/tokens.ts', () => {
    run();
    const c = readFileSync(css, 'utf8');
    expect(c).toMatch(/--lims-accent\s*:/);
    expect(c.toUpperCase()).toContain('#1D4ED8');
    expect(existsSync(ts)).toBe(true);
  });

  it('Dart output carries the default accent and no URLs', () => {
    const d = readFileSync(dart, 'utf8');
    expect(d.toUpperCase()).toMatch(/1D4ED8/);
    expect(d).not.toMatch(/https?:\/\//);
  });
});
