// C14 T28 — LLM client plumbing (02-TRD §4.11, §9.1; AC-20.5; 07-SECURITY 007, 101): endpoint host allowlist (startup refusal), rephraser registry, circuit breaker.
// No network here. Metrics are best effort (a missing sink never breaks the caller); labels carry no ids or text.
import type { SmartreportConfig } from './config.js';
import { DisabledRephraser } from './llm/DisabledRephraser.js';
import type { LlmRephraser } from './llm/LlmRephraser.js';

type Sink = { inc?: (n: string, l?: Record<string, string | number>, by?: number) => void; set?: (n: string, v: number, l?: Record<string, string | number>) => void };
export interface MetricsCtx { metrics?: Sink }
const sinkOf = (ctx: unknown): Sink | undefined => (ctx as MetricsCtx | undefined)?.metrics;
const safe = (f: () => void): void => { try { f(); } catch { /* best effort */ } };

const REFUSED = 'lims_smartreport_llm_endpoint_refused_total';
const CIRCUIT = 'lims_smartreport_llm_circuit_open';

/** Adapter 'disabled' uses no endpoint. Otherwise the endpoint host (userinfo, port, path ignored) must equal an LLM_ALLOWED_HOSTS entry, case-insensitive; else throws (alert SmartLlmEndpointNotAllowed). */
export function assertLlmEndpointAllowed(cfg: SmartreportConfig, ctx?: MetricsCtx): void {
  if (cfg.llmAdapter === 'disabled') return;
  let host: string | undefined;
  try { host = cfg.llmEndpoint === undefined ? undefined : new URL(cfg.llmEndpoint).hostname.toLowerCase(); } catch { host = undefined; }
  if (host !== undefined && cfg.llmAllowedHosts.some((h) => h.toLowerCase() === host)) return;
  safe(() => sinkOf(ctx)?.inc?.(REFUSED));
  throw new Error('smartreport llm: endpoint host is not on LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS');   // never echoes the URL (credentials / query)
}

const registry = new Map<string, (cfg: SmartreportConfig) => LlmRephraser>();
export function registerRephraser(name: string, factory: (cfg: SmartreportConfig) => LlmRephraser): void { registry.set(name, factory); }

/** The allowlist is checked BEFORE the factory runs (no client is built for a refused host). Unknown adapter name: fail closed. */
export function resolveRephraser(cfg: SmartreportConfig, ctx?: MetricsCtx): LlmRephraser {
  if (cfg.llmAdapter === 'disabled') return new DisabledRephraser();
  assertLlmEndpointAllowed(cfg, ctx);
  const factory = registry.get(cfg.llmAdapter);
  if (factory === undefined) throw new Error('smartreport llm: unknown LIMS_SMARTREPORT_LLM_ADAPTER');
  return factory(cfg);
}

const FAILURES_TO_OPEN = 5, OPEN_MS = 10 * 60_000;                  // 02-TRD §9.1 [CONV]
export class LlmCircuitBreaker {
  private failures = 0;
  private openUntil: number | null = null;
  private readonly now: () => number;
  constructor(o: { now?: () => number } = {}) { this.now = o.now ?? Date.now; }

  isOpen(ctx?: MetricsCtx): boolean {
    if (this.openUntil === null) return false;
    if (this.now() < this.openUntil) return true;
    this.openUntil = null; this.failures = 0;                      // half-open: the next call decides
    safe(() => sinkOf(ctx)?.set?.(CIRCUIT, 0));
    return false;
  }
  recordFailure(ctx?: MetricsCtx): void {
    if (++this.failures < FAILURES_TO_OPEN) return;
    this.openUntil = this.now() + OPEN_MS;
    safe(() => sinkOf(ctx)?.set?.(CIRCUIT, 1));
  }
  recordSuccess(ctx?: MetricsCtx): void {
    this.failures = 0;
    if (this.openUntil !== null) { this.openUntil = null; safe(() => sinkOf(ctx)?.set?.(CIRCUIT, 0)); }
  }
}
/** Process-wide breaker used by the worker task (one LLM endpoint per process). */
export const llmCircuit = new LlmCircuitBreaker();
