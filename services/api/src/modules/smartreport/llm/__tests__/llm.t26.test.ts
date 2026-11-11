// C14 T26 — LlmRephraser interface, DisabledRephraser, fake, prompt.v1, function-words.en. AC-20.1 (disabled path: zero network IO).
// Specs: 02-TRD §4.11/§4.12, 07-SECURITY (LLM: disabled -> zero outbound calls).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import type { LlmRephraseInput, LlmRephraser } from '../LlmRephraser.js';
import { DisabledRephraser } from '../DisabledRephraser.js';
import { FakeRephraser } from '../FakeRephraser.js';
import * as prompt from '../prompt.v1.js';
import * as functionWords from '../function-words.en.js';

const input = (n = 2, language: 'en' | 'ne' = 'en'): LlmRephraseInput => ({
  language, promptTemplateVersion: 'p1',
  items: Array.from({ length: n }, (_, i) => ({ itemRef: `advice:blk-${i}`, templateText: `Please review {analyte} with your doctor ${i}.` })),
});
const opts = (signal: AbortSignal = new AbortController().signal) => ({ timeoutMs: 20000, signal });
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  spies = [
    vi.spyOn(globalThis, 'fetch'),
    vi.spyOn(http, 'request'), vi.spyOn(http, 'get'), vi.spyOn(https, 'request'), vi.spyOn(https, 'get'),
    vi.spyOn(net, 'connect'), vi.spyOn(net, 'createConnection'), vi.spyOn(net.Socket.prototype, 'connect'),
    vi.spyOn(tls, 'connect'), vi.spyOn(dns, 'lookup'), vi.spyOn(dns, 'resolve'),
  ];
});
afterEach(() => { vi.restoreAllMocks(); });
const networkCalls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);

describe('T26 DisabledRephraser (AC-20.1)', () => {
  it('rejects with LimsError smartreport.feature_disabled (403) and makes zero network calls', async () => {
    const r: LlmRephraser = new DisabledRephraser();
    const e = await fails(r.rephrase(input(), opts()));
    expect(e).toBeInstanceOf(LimsError);
    expect(e.code).toBe('smartreport.feature_disabled');
    expect(e.statusCode).toBe(403);
    expect(networkCalls()).toBe(0);
  });

  it('returns a rejected promise (does not throw synchronously)', () => {
    const r = new DisabledRephraser();
    let p: Promise<unknown> | undefined;
    expect(() => { p = r.rephrase(input(), opts()); }).not.toThrow();
    return expect(p).rejects.toBeInstanceOf(LimsError);
  });

  it.each([[0], [1], [30]])('same outcome and no network for %i items, both languages, any timeout', async (n) => {
    const r = new DisabledRephraser();
    for (const lang of ['en', 'ne'] as const) {
      expect((await fails(r.rephrase(input(n, lang), { timeoutMs: 1, signal: new AbortController().signal }))).code).toBe('smartreport.feature_disabled');
    }
    expect(networkCalls()).toBe(0);
  });

  it('already-aborted signal still yields feature_disabled, still no network', async () => {
    const ac = new AbortController(); ac.abort();
    expect((await fails(new DisabledRephraser().rephrase(input(), opts(ac.signal)))).code).toBe('smartreport.feature_disabled');
    expect(networkCalls()).toBe(0);
  });

  it('error text does not echo input template text (no health-linked content in errors/logs)', async () => {
    const e = await fails(new DisabledRephraser().rephrase(input(), opts()));
    expect(JSON.stringify({ m: e.message, d: e.detail })).not.toContain('review {analyte}');
  });

  it('is stateless: many parallel calls all reject the same way, zero network', async () => {
    const r = new DisabledRephraser();
    const out = await Promise.allSettled(Array.from({ length: 50 }, () => r.rephrase(input(), opts())));
    expect(out.every((o) => o.status === 'rejected' && (o.reason as LimsError).code === 'smartreport.feature_disabled')).toBe(true);
    expect(networkCalls()).toBe(0);
  });
});

describe('T26 fake rephraser (CI double)', () => {
  it('implements LlmRephraser: one output per itemRef, in order, with a modelRef label; no network', async () => {
    const r: LlmRephraser = new FakeRephraser();
    const inp = input(3);
    const out = await r.rephrase(inp, opts());
    expect(out.items.map((i) => i.itemRef)).toEqual(inp.items.map((i) => i.itemRef));
    expect(out.items.every((i) => typeof i.text === 'string' && i.text.length > 0)).toBe(true);
    expect(typeof out.modelRef).toBe('string');
    expect(out.modelRef.length).toBeGreaterThan(0);
    expect(networkCalls()).toBe(0);
  });

  it('captures the request it received so callers can assert on it (T28 "captured request")', async () => {
    const r = new FakeRephraser();
    const inp = input(2);
    await r.rephrase(inp, opts());
    expect((r as any).calls).toHaveLength(1);
    expect((r as any).calls[0].input).toEqual(inp);
  });
});

describe('T26 prompt.v1', () => {
  const strings = Object.values(prompt).filter((v): v is string => typeof v === 'string');
  it('exports version p1 and instruction text covering the §4.11 rules', () => {
    expect(strings).toContain('p1');
    const text = strings.filter((s) => s !== 'p1').join('\n').toLowerCase();
    expect(text).toContain('{placeholder}');
    expect(text).toMatch(/itemref/);
    for (const forbidden of ['facts', 'numbers', 'names', 'medicines', 'products', 'links', 'advice']) expect(text).toContain(forbidden);
  });
  it('contains no patient data, URLs or digits that could leak into a request', () => {
    const text = strings.filter((s) => s !== 'p1').join('\n');
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/[0-9०-९]/);
  });
});

describe('T26 function-words.en', () => {
  const list = (() => {
    for (const v of Object.values(functionWords)) {
      if (v instanceof Set) return [...v] as string[];
      if (Array.isArray(v)) return v as string[];
    }
    return [] as string[];
  })();
  it('exports a bundled non-empty allowlist of lower-case words', () => {
    expect(list.length).toBeGreaterThan(20);
    expect(list.every((w) => typeof w === 'string' && w === w.toLowerCase() && /^\p{L}+$/u.test(w))).toBe(true);
  });
  it('has common function words but no health-content, medicine, product or number words (novelty check stays conservative)', () => {
    for (const w of ['the', 'and', 'with', 'your', 'about', 'this', 'that', 'should']) expect(list).toContain(w);
    for (const w of ['iron', 'tablet', 'tablets', 'medicine', 'vitamin', 'dose', 'twice', 'daily', 'diabetes', 'cholesterol']) expect(list).not.toContain(w);
  });
});
