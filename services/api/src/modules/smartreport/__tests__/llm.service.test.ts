// C14 T28 — llm.service.ts: host allowlist + startup refusal (AC-20.5, 07-SECURITY 007), rephraser registry, circuit breaker (02-TRD §9.1: 5 consecutive failures -> open 10 min [CONV]).
// Seams pinned here (the spec fixes behaviour + metric names, not TypeScript shapes); all exported from ../llm.service.ts:
//   assertLlmEndpointAllowed(cfg: SmartreportConfig, ctx?: { metrics?: { inc } }): void   adapter 'disabled' -> returns (no endpoint is used); otherwise the host of cfg.llmEndpoint must equal
//        (case-insensitive, port ignored) an entry of cfg.llmAllowedHosts, else throws an Error AND ctx.metrics.inc('lims_smartreport_llm_endpoint_refused_total') once (alert SmartLlmEndpointNotAllowed).
//   registerRephraser(name: string, factory: (cfg) => LlmRephraser): void; resolveRephraser(cfg, ctx?): LlmRephraser   'disabled' -> DisabledRephraser; unknown name -> throws;
//        the allowlist is checked BEFORE the factory runs ("the worker refuses to start the LLM client").
//   new LlmCircuitBreaker({ now?: () => number /* default Date.now */ }) with isOpen(ctx?), recordFailure(ctx?), recordSuccess(ctx?); gauge ctx.metrics.set('lims_smartreport_llm_circuit_open', 0|1) (no labels).
//   export const llmCircuit: LlmCircuitBreaker — the process-wide breaker the worker task uses (recordSuccess() resets the consecutive-failure count).
// Fails now: ../llm.service.ts does not exist.
import { describe, expect, it, vi } from 'vitest';
import { loadSmartreportConfig } from '../config.js';
import { DisabledRephraser } from '../llm/DisabledRephraser.js';
import { FakeRephraser } from '../llm/FakeRephraser.js';
import { LlmCircuitBreaker, assertLlmEndpointAllowed, registerRephraser, resolveRephraser } from '../llm.service.js';

const REFUSED = 'lims_smartreport_llm_endpoint_refused_total';
const CIRCUIT = 'lims_smartreport_llm_circuit_open';
const cfgOf = (env: Record<string, string | undefined>) => loadSmartreportConfig({
  LIMS_SMARTREPORT_LLM_ADAPTER: 'fake-t28', LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://llm.internal.example/v1', LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS: 'llm.internal.example', ...env });
const sink = () => ({ metrics: { inc: vi.fn(), set: vi.fn() } });
const threw = (f: () => unknown): Error | undefined => { try { f(); } catch (e) { return e as Error; } return undefined; };

describe('C14-T28 assertLlmEndpointAllowed — AC-20.5', () => {
  it('endpoint host on the allowlist -> accepted, no alert', () => {
    const c = sink();
    expect(threw(() => assertLlmEndpointAllowed(cfgOf({}), c))).toBeUndefined();
    expect(c.metrics.inc).not.toHaveBeenCalled();
  });

  it('host match is case-insensitive and ignores the port', () => {
    expect(threw(() => assertLlmEndpointAllowed(cfgOf({ LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://LLM.Internal.Example:8443/x' })))).toBeUndefined();
  });

  it('adapter "disabled" (default): nothing to check, never refuses, no alert', () => {
    const c = sink();
    expect(threw(() => assertLlmEndpointAllowed(loadSmartreportConfig({}), c))).toBeUndefined();
    expect(threw(() => assertLlmEndpointAllowed(cfgOf({ LIMS_SMARTREPORT_LLM_ADAPTER: 'disabled', LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS: undefined }), c))).toBeUndefined();
    expect(c.metrics.inc).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string | undefined>]>([
    ['host not on the list', { LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://api.foreign-llm.example/v1' }],
    ['empty allowlist (default)', { LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS: undefined }],
    ['no endpoint configured', { LIMS_SMARTREPORT_LLM_ENDPOINT: undefined }],
    ['allowed name only as a prefix of the real host', { LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://llm.internal.example.evil.example/' }],
    ['allowed name only as a suffix of the real host', { LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://evil-llm.internal.example/' }],
    ['allowed name hidden in userinfo (real host evil.example)', { LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://llm.internal.example@evil.example/' }],
    ['allowed name in path/query only', { LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://evil.example/llm.internal.example?h=llm.internal.example' }],
    ['IP literal not listed', { LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://203.0.113.7/' }],
  ])('refused: %s -> throws and counts lims_smartreport_llm_endpoint_refused_total once', (_n, env) => {
    const c = sink();
    expect(threw(() => assertLlmEndpointAllowed(cfgOf(env), c))).toBeInstanceOf(Error);
    expect(c.metrics.inc.mock.calls.filter((x) => x[0] === REFUSED)).toHaveLength(1);
  });

  it('the refusal never echoes credentials or the full URL of the endpoint (secret hygiene)', () => {
    const e = threw(() => assertLlmEndpointAllowed(cfgOf({ LIMS_SMARTREPORT_LLM_ENDPOINT: 'https://svc-user:S3CR3T-TOKEN@evil.example/v1?key=SECRET-KEY' })));
    expect(e).toBeInstanceOf(Error);
    expect(String(e!.message) + String((e as any).stack ?? '')).not.toMatch(/S3CR3T-TOKEN|SECRET-KEY/);
  });
});

describe('C14-T28 rephraser registry — the client is not started for a refused host', () => {
  it('adapter disabled -> DisabledRephraser', () => {
    expect(resolveRephraser(loadSmartreportConfig({}))).toBeInstanceOf(DisabledRephraser);
  });

  it('registered adapter on an allowed host -> the factory result, built with the config', () => {
    const fake = new FakeRephraser(); const factory = vi.fn(() => fake);
    registerRephraser('fake-t28', factory);
    const cfg = cfgOf({});
    expect(resolveRephraser(cfg)).toBe(fake);
    expect(factory).toHaveBeenCalledWith(cfg);
  });

  it('host not allowed -> throws, factory NOT called (no client is constructed), alert metric incremented', () => {
    const factory = vi.fn(() => new FakeRephraser()); registerRephraser('fake-t28-refused', factory);
    const c = sink();
    expect(threw(() => resolveRephraser(cfgOf({ LIMS_SMARTREPORT_LLM_ADAPTER: 'fake-t28-refused', LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS: 'other.internal.example' }), c))).toBeInstanceOf(Error);
    expect(factory).not.toHaveBeenCalled();
    expect(c.metrics.inc.mock.calls.filter((x) => x[0] === REFUSED)).toHaveLength(1);
  });

  it('unknown adapter name -> throws (fail closed), never falls back to a network client', () => {
    expect(threw(() => resolveRephraser(cfgOf({ LIMS_SMARTREPORT_LLM_ADAPTER: 'no-such-adapter' })))).toBeInstanceOf(Error);
  });
});

describe('C14-T28 LlmCircuitBreaker — 5 consecutive failures open it for 10 minutes', () => {
  const mk = () => { let t = 1_000_000; const b = new LlmCircuitBreaker({ now: () => t }); return { b, advance: (ms: number) => { t += ms; }, c: sink() }; };

  it('closed at start; 4 failures keep it closed', () => {
    const { b, c } = mk();
    for (let i = 0; i < 4; i++) b.recordFailure(c);
    expect(b.isOpen(c)).toBe(false);
  });

  it('the 5th consecutive failure opens it and sets lims_smartreport_llm_circuit_open to 1', () => {
    const { b, c } = mk();
    for (let i = 0; i < 5; i++) b.recordFailure(c);
    expect(b.isOpen(c)).toBe(true);
    expect(c.metrics.set.mock.calls.at(-1)?.slice(0, 2)).toEqual([CIRCUIT, 1]);
  });

  it('a success in between resets the count: 4 failures, 1 success, 4 failures -> still closed', () => {
    const { b, c } = mk();
    for (let i = 0; i < 4; i++) b.recordFailure(c);
    b.recordSuccess(c);
    for (let i = 0; i < 4; i++) b.recordFailure(c);
    expect(b.isOpen(c)).toBe(false);
  });

  it('stays open just under 10 minutes, closes at 10 minutes and the gauge goes back to 0', () => {
    const { b, c, advance } = mk();
    for (let i = 0; i < 5; i++) b.recordFailure(c);
    advance(10 * 60_000 - 1);
    expect(b.isOpen(c)).toBe(true);
    advance(1);
    expect(b.isOpen(c)).toBe(false);
    expect(c.metrics.set.mock.calls.at(-1)?.slice(0, 2)).toEqual([CIRCUIT, 0]);
  });

  it('after reopening, one more failure counts from zero (needs 5 again)', () => {
    const { b, c, advance } = mk();
    for (let i = 0; i < 5; i++) b.recordFailure(c);
    advance(10 * 60_000);
    expect(b.isOpen(c)).toBe(false);
    b.recordFailure(c);
    expect(b.isOpen(c)).toBe(false);
  });

  it('missing metrics sink never breaks the breaker (best effort)', () => {
    const { b } = mk();
    for (let i = 0; i < 5; i++) b.recordFailure();
    expect(b.isOpen()).toBe(true);
  });
});
