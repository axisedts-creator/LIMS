// T0B-CONTENT-1 done_when (2), LD-313 (d): the ONE shared Markdown helper. Pure unit tests, no database.
// PINNED interface (tester's pick; the lead may overrule, then edit this file): services/api/src/modules/engagement/service/safeMarkdown.ts exports
//   MARKDOWN_MAX_CHARS = 20000
//   validateMarkdown(src: string): { ok: true } | { ok: false; reason: string }   (write side; the handlers answer 400 common.validation_failed path /body)
//   renderMarkdown(src: string): string                                           (read side; HTML that is safe to inject; throws on a body over the limit)
// Allowed subset (contract PortalContentCreate.body): headings #..######, **bold**, *italic* / _italic_, bullet and numbered lists, [text](https://...) links. Nothing else.
import { describe, expect, it } from 'vitest';

const mod: any = await import('../../service/safeMarkdown.js').catch((e: Error) => ({ __missing: e.message }));
const need = (): { validateMarkdown: (s: string) => { ok: boolean; reason?: string }; renderMarkdown: (s: string) => string; MARKDOWN_MAX_CHARS: number } => {
  if (mod.__missing) throw new Error(`services/api/src/modules/engagement/service/safeMarkdown.ts is missing (${mod.__missing})`);
  return mod;
};
const ok = (s: string) => expect(need().validateMarkdown(s), s.slice(0, 80)).toMatchObject({ ok: true });
const bad = (s: string) => { const r = need().validateMarkdown(s); expect(r.ok, `accepted: ${JSON.stringify(s.slice(0, 80))}`).toBe(false); expect(typeof r.reason).toBe('string'); };
const ALLOWED_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'br']);
const tagsOf = (html: string): string[] => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase());
/** the only thing a reader may get back: whitelisted tags, a-tags carrying an https href and no other attribute than rel / target, no event handler, no script */
function expectSafeHtml(html: string): void {
  expect(tagsOf(html).filter((t) => !ALLOWED_TAGS.has(t)), `tags outside the whitelist in ${html}`).toEqual([]);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/data:text/i);
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    expect(m[1], `a tag: ${m[0]}`).toMatch(/href="https:\/\/[^"\s<>]+"/);
    expect([...m[1]!.matchAll(/\s([a-z-]+)=/gi)].map((x) => x[1]!.toLowerCase()).filter((n) => !['href', 'rel', 'target'].includes(n)), `extra attribute in ${m[0]}`).toEqual([]);
  }
}

describe('T0B-CONTENT-1: safeMarkdown.validateMarkdown (write side)', () => {
  it('the helper exists and exports the pinned names', () => {
    const m = need();
    expect(typeof m.validateMarkdown).toBe('function'); expect(typeof m.renderMarkdown).toBe('function'); expect(m.MARKDOWN_MAX_CHARS).toBe(20000);
  });
  it('accepts the whole allowed subset (contract example included)', () => {
    ok('## Opening hours\n\nFrom **1 December** we open at 6:30.\n\n- Sunday to Friday\n- Saturday closed\n\n[Details](https://example.org/hours)');
    ok('# H1\n###### H6\n*it* and _it_ and **bold**\n\n1. one\n2. two\n\n* a\n* b');
    ok('Open **6:30 to 18:00**, Sunday to Friday.\n\n[Find us](https://example.org/map?x=1&y=2#top)');
    ok(''); ok('plain text only'); ok('नमस्ते — synthetic Nepali and Unicode text, 2 more is fine');
    ok('a'.repeat(20000));
  });
  it('rejects an oversized body (20001 characters)', () => { bad('a'.repeat(20001)); });
  it('rejects every raw HTML form: tags, scripts, comments, autolinks, a bare "<"', () => {
    for (const s of ['<script>alert(1)</script>', '<SCRIPT SRC=https://evil.example/x.js></SCRIPT>', 'hi <b>bold</b>', '<img src=x onerror=alert(1)>', '<svg/onload=alert(1)>',
      '<iframe src="https://evil.example"></iframe>', '<!-- c -->', '<https://example.org/auto>', 'a < b', '<a href="https://example.org">x</a>', '<div><p><div>nested</div></p></div>',
      '**<u>bold</u>**', '- item <script>x</script>', '[x](https://example.org/<b>)', '<style>*{}</style>', '<math><mi xlink:href="data:x">', 'escaped in source: <script>'])
      bad(s);
  });
  it('rejects non https links: javascript:, data:, vbscript:, http:, protocol relative, relative, mixed case, padded, control characters', () => {
    for (const s of ['[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x]( javascript:alert(1))', '[x](\tjavascript:alert(1))', '[x](java\nscript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](vbscript:msgbox(1))', '[x](http://example.org)', '[x](//example.org)', '[x](/relative)', '[x](example.org)', '[x](HTTPS://example.org)', '[x]( https://example.org)', '[x](ftp://example.org)',
      '[ok](https://example.org) and [bad](http://example.org)', '[x](&#106;avascript:alert(1))', '[x](\u0001javascript:alert(1))'])
      bad(s);
  });
  it('rejects images, reference style link definitions, numeric character references, NUL and C0 control characters', () => {
    for (const s of ['![alt](https://example.org/a.png)', '![](https://example.org/a.png)', '[x][1]\n\n[1]: https://example.org', '[1]: javascript:alert(1)', '&#60;script&#62;', '&#x3c;script&#x3e;',
      'text\u0000more', 'text\u0007more', 'text\u001bmore'])
      bad(s);
  });
  it('allows a tab and newlines (ordinary text), and a literal named entity as plain text', () => { ok('a\tb\r\nc\nd'); ok('Tom &amp; Jerry &lt;3'); });
  it('is linear time on hostile input (no catastrophic backtracking)', () => {
    const t0 = Date.now();
    for (const s of ['*'.repeat(19999), '['.repeat(9999) + '(' .repeat(9999), '**_'.repeat(6666), '[x]('.repeat(3999), '- '.repeat(9999), '#'.repeat(19999), ' '.repeat(19999) + '<']) {
      need().validateMarkdown(s);
      try { need().renderMarkdown(s); } catch { /* a refusal is fine, a hang is not */ }
    }
    expect(Date.now() - t0, 'ms for 7 hostile 20k inputs').toBeLessThan(2000);
  });
});

describe('T0B-CONTENT-1: safeMarkdown.renderMarkdown (read side)', () => {
  it('renders the subset to whitelisted HTML', () => {
    const h = need().renderMarkdown('## Opening hours\n\nFrom **1 December** we *open* at _6:30_.\n\n- Sunday to Friday\n- Saturday closed\n\n1. one\n2. two\n\n[Details](https://example.org/hours)');
    expectSafeHtml(h);
    expect(h).toMatch(/<h2>\s*Opening hours\s*<\/h2>/); expect(h).toContain('<strong>1 December</strong>'); expect(h.match(/<em>/g)).toHaveLength(2);
    expect(h).toMatch(/<ul>[\s\S]*<li>\s*Sunday to Friday\s*<\/li>[\s\S]*<li>\s*Saturday closed\s*<\/li>[\s\S]*<\/ul>/); expect(h).toMatch(/<ol>[\s\S]*<li>\s*one\s*<\/li>[\s\S]*<\/ol>/);
    expect(h).toMatch(/<a [^>]*href="https:\/\/example\.org\/hours"[^>]*>Details<\/a>/);
  });
  it('external links get rel="noopener noreferrer" (no opener, no referrer leak from the patient app)', () => {
    const h = need().renderMarkdown('[x](https://example.org)');
    expect(h).toMatch(/rel="[^"]*noopener[^"]*"/); expect(h).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });
  it('stored text that is dirty anyway (inserted by an older writer or by hand) is escaped, never passed through', () => {
    for (const s of ['<script>alert(1)</script>', 'x <img src=x onerror=alert(1)> y', '<a href="javascript:alert(1)">x</a>', '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](http://example.org)',
      '[x](data:text/html,<script>alert(1)</script>)', '![x](https://example.org/a.png)', '<div><div><div><div><script>x</script></div></div></div></div>', '&#60;script&#62;alert(1)&#60;/script&#62;',
      '"><script>alert(1)</script>', "'-alert(1)-'", '[<img src=x onerror=alert(1)>](https://example.org)', '[x](https://example.org" onmouseover="alert(1))', '[x](https://example.org/a"onfocus="x)']) {
      const h = need().renderMarkdown(s);
      expectSafeHtml(h);
      expect(h, `an unescaped "<" from the input survives in ${JSON.stringify(h)}`).not.toMatch(/<(?!\/?(?:h[1-6]|p|strong|em|ul|ol|li|a|br)\b)/);
    }
  });
  it('the visible text of a refused link stays text (escaped), not a link', () => {
    const h = need().renderMarkdown('[click](javascript:alert(1))');
    expect(h).not.toContain('<a'); expect(h).toContain('click');
  });
  it('a quote in a URL cannot break out of the href attribute', () => {
    const h = need().renderMarkdown('[x](https://example.org/a"onmouseover="alert(1))');
    for (const m of h.matchAll(/<a\b[^>]*>/g)) expect(m[0].match(/"/g)!.length % 2, m[0]).toBe(0);
    expectSafeHtml(h);
  });
  it('an oversized body is refused, not rendered', () => {
    expect(() => need().renderMarkdown('a'.repeat(20001))).toThrow();
    expect(() => need().renderMarkdown('a'.repeat(20000))).not.toThrow();
  });
  it('empty and whitespace only bodies render to an empty-ish string without throwing', () => {
    expect(need().renderMarkdown('').trim()).toBe(''); expect(need().renderMarkdown('  \n \n').trim()).toBe('');
  });
  it('is pure and repeatable', () => { const s = '**a** [b](https://example.org)'; expect(need().renderMarkdown(s)).toBe(need().renderMarkdown(s)); });
});
