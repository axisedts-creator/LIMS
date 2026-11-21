// T0D-MSGDESK-1 — partner portal static checks (tester-owned; node environment). LD-140 kit-only rules, 02-TRD §3.6 segment files, isolation (no lab side path in the partner app), no new library.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(import.meta.dirname, '..', '..'); // apps/partner
const SRC = join(APP, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const rel = (p: string) => relative(APP, p).split('\\').join('/');
const SEG = join(SRC, 'app', '(app)', 'tickets');
const FEATURE = walk(join(SRC, 'features', 'tickets')).filter((f) => /\.(ts|tsx)$/.test(f));
const PAGES = [join(SEG, 'page.tsx'), join(SEG, 'new', 'page.tsx'), join(SEG, '[ticket_id]', 'page.tsx')];
const MINE = [...PAGES, ...FEATURE].filter(existsSync);

describe('partner tickets: files', () => {
  it.each(PAGES.map((p) => [rel(p), p]))('%s exists', (_n, p) => { expect(existsSync(p as string)).toBe(true); });
  it('the tickets segment has loading.tsx and error.tsx (02-TRD §3.6)', () => {
    expect(existsSync(join(SEG, 'loading.tsx'))).toBe(true);
    expect(existsSync(join(SEG, 'error.tsx'))).toBe(true);
  });
  it('the write actions live in features/tickets/actions.ts as a "use server" + server-only file', () => {
    const f = join(SRC, 'features', 'tickets', 'actions.ts');
    expect(existsSync(f)).toBe(true);
    const t = read(f);
    expect(t).toMatch(/^'use server'/m);
    expect(t).toMatch(/import 'server-only'/);
    expect(t).toMatch(/idempotency-key/i);
    expect(t).toMatch(/me\/tickets/);
  });
  it('the shell nav has the Tickets entry guarded by partners.ticket.read', () => {
    const t = read(join(SRC, 'features', 'shell', 'PartnerShell.tsx'));
    expect(t).toMatch(/href: '\/tickets'/);
    expect(t).toMatch(/partners\.ticket\.read/);
  });
});

describe('partner tickets: isolation and kit rules', () => {
  it('no file of the partner app names the lab side ticket paths (/admin/tickets, close, reopen): a partner only creates and replies', () => {
    for (const f of walk(SRC).filter((x) => /\.(ts|tsx)$/.test(x))) expect(read(f), rel(f)).not.toMatch(/admin\/tickets|tickets\/\$\{[^}]+\}\/(close|reopen)/);
  });
  it('the ticket files never put a party / partner id into a request body or a query', () => {
    for (const f of MINE) expect(read(f), rel(f)).not.toMatch(/party_id|party_kind|partner_id/);
  });
  it('no client file calls fetch directly, uses browser storage for ticket text or sets inner HTML', () => {
    for (const f of MINE) { const t = read(f); expect(/\bfetch\(|XMLHttpRequest/.test(t), rel(f)).toBe(false); expect(/localStorage|sessionStorage|indexedDB/.test(t), `${rel(f)} browser storage`).toBe(false); expect(t, rel(f)).not.toMatch(/dangerouslySetInnerHTML/); }
  });
  it('LD-140: kit components only: no hex colours, no inline style objects, no exclamation marks in visible copy', () => {
    for (const f of MINE.filter((x) => x.endsWith('.tsx'))) {
      const t = read(f).replace(/\/\/.*$/gm, '');
      expect(/#[0-9a-fA-F]{3,8}\b/.test(t), `${rel(f)} hex colour`).toBe(false);
      expect(/style=\{\{/.test(t), `${rel(f)} inline style`).toBe(false);
      expect(/>[^<{]*!/.test(t), `${rel(f)} exclamation mark`).toBe(false);
    }
  });
  it('no new dependency in apps/partner/package.json', () => {
    const pkg = JSON.parse(read(join(APP, 'package.json'))) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@lims/ui', 'next', 'react', 'react-dom', 'server-only']);
  });
});
