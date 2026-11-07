// Chromium pool (02-TRD §5.1): 1 browser, at most N concurrent contexts, recycle after K renders or RSS > 85 % of the
// container limit, per-job timeout (408), page limit (422), JS disabled, request guard, bundled fonts.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { CHROMIUM_ARGS, countLocalResourceRefusals, guardContext } from './guard.js';

export class RenderError extends Error {
  readonly httpStatus: 400 | 408 | 422 | 503;
  constructor(httpStatus: 400 | 408 | 422 | 503, message: string) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export type PoolOptions = {
  contexts?: number;
  recycleAfter?: number;
  timeoutMs?: number;
  maxPages?: number;
  memoryLimitBytes?: number;
};

/** Header/footer keys only (spike technique candidate); path etc. cannot be set by callers. */
export type PdfOverrides = Pick<NonNullable<Parameters<Page['pdf']>[0]>,'displayHeaderFooter' | 'headerTemplate' | 'footerTemplate' | 'margin'>;
export type RenderHtmlOptions = { pdf?: PdfOverrides; templateId?: string };

const envInt = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isInteger(v) && v > 0 ? v : d;
};

const readNum = (p: string): number | undefined => {
  try {
    const n = Number(readFileSync(p, 'utf8').trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
};

// ponytail: cgroup v2 container memory (all processes incl. Chromium); outside a container falls back to this node
// process's RSS only. Add per-process accounting if the renderer ever runs uncontained in production.
const rssBytes = () => readNum('/sys/fs/cgroup/memory.current') ?? process.memoryUsage().rss;
const containerLimit = () => readNum('/sys/fs/cgroup/memory.max') ?? 1.5 * 1024 ** 3;

// Bundled fonts (02-TRD §1, AC-03.4). In the image they are also installed into fontconfig; injecting them as data:
// @font-face guarantees the bundled files are used on any host (data: is the only scheme the guard lets through).
const FONT_DIR = fileURLToPath(new URL('../fonts/', import.meta.url));
const FONT_CSS = readdirSync(FONT_DIR)
  .filter((f) => /^NotoSans.*-(Regular|Bold)\.ttf$/.test(f))
  .map((f) => {
    const [, fam, w] = /^(NotoSans(?:Devanagari|Mono)?)-(Regular|Bold)/.exec(f)!;
    const family = fam!.replace(/(Sans|Devanagari|Mono)/g, ' $1');
    const b64 = readFileSync(FONT_DIR + f).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${w === 'Bold' ? 700 : 400};src:url(data:font/ttf;base64,${b64}) format('truetype')}`;
  })
  .join('');
const FONT_STYLE = `<style>${FONT_CSS}</style>`;

/** Fonts go right after the doctype (or first) so the document's own mode and <head> are untouched. */
const withFonts = (html: string) => {
  const m = /^\s*<!doctype[^>]*>/i.exec(html);
  return m ? m[0] + FONT_STYLE + html.slice(m[0].length) : FONT_STYLE + html;
};

const countPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;

export async function createPool(opts: PoolOptions = {}) {
  const max = opts.contexts ?? envInt('LIMS_RENDERER_CONTEXTS', 4);
  const recycleAfter = opts.recycleAfter ?? envInt('LIMS_RENDERER_RECYCLE_AFTER', 200);
  const timeoutMs = opts.timeoutMs ?? envInt('LIMS_RENDERER_TIMEOUT_MS', 30_000);
  const maxPages = opts.maxPages ?? envInt('LIMS_RENDERER_MAX_PAGES', 60);
  const memLimit = opts.memoryLimitBytes ?? containerLimit();

  const registry = new Registry();
  const m = {
    duration: new Histogram({ name: 'lims_renderer_render_duration_seconds', help: 'Render duration', labelNames: ['template_id'], registers: [registry] }),
    recycles: new Counter({ name: 'lims_renderer_browser_recycles_total', help: 'Browser recycles', registers: [registry] }),
    blocked: new Counter({ name: 'lims_renderer_blocked_requests_total', help: 'Requests blocked by the guard', registers: [registry] }),
  };
  new Gauge({ name: 'lims_renderer_contexts_busy', help: 'Busy contexts', registers: [registry], collect() { this.set(busy); } });
  new Gauge({ name: 'lims_renderer_rss_bytes', help: 'Renderer RSS', registers: [registry], collect() { this.set(rssBytes()); } });

  const launch = () => chromium.launch({ args: CHROMIUM_ARGS });
  let browser = await launch();
  let relaunching: Promise<Browser> | undefined;
  let closed = false;
  let busy = 0;
  let sinceLaunch = 0;
  let recycles = 0;
  let blocked = 0;
  let rendered = 0;
  let needRecycle = false;
  const waiters: (() => void)[] = [];

  const relaunch = (old: Browser) =>
    (relaunching ??= (async () => {
      await old.close().catch(() => {});
      browser = await launch();
      sinceLaunch = 0;
      return browser;
    })().finally(() => (relaunching = undefined)));

  const acquire = async () => {
    // A pending recycle drains the pool first, so it cannot starve under constant load.
    while (busy >= max || (needRecycle && busy > 0)) await new Promise<void>((r) => waiters.push(r));
    busy++;
  };
  const release = () => {
    busy--;
    for (const w of waiters.splice(0)) w(); // waiters re-check; N ≤ 4 so the herd is small
  };

  async function renderHtml(html: string, o: RenderHtmlOptions = {}): Promise<{ pdf: Uint8Array; pageCount: number }> {
    if (closed) throw new RenderError(503, 'pool closed');
    await acquire();
    const end = m.duration.startTimer({ template_id: o.templateId ?? '' });
    let ctx: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Recycle only when this job is alone, so no in-flight render loses its browser.
      if (needRecycle && busy === 1) {
        needRecycle = false;
        await relaunch(browser);
        recycles++;
        m.recycles.inc();
      }
      if (relaunching) await relaunching;
      if (!browser.isConnected()) await relaunch(browser); // crashed: relaunch once, shared by concurrent callers
      ctx = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: 'block' });
      const onBlocked = () => {
        blocked++;
        m.blocked.inc();
      };
      await guardContext(ctx, onBlocked);
      const c = ctx;
      const work = (async () => {
        const page = await c.newPage();
        countLocalResourceRefusals(page, onBlocked);
        await page.setContent(withFonts(html), { waitUntil: 'load', timeout: 0 });
        await page.evaluate(() => document.fonts.ready).catch(() => {}); // utility world; page JS stays off
        return page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, ...o.pdf });
      })();
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new RenderError(408, 'render timeout')), timeoutMs);
      });
      let pdf: Buffer;
      try {
        pdf = await Promise.race([work, timeout]);
      } catch (e) {
        work.catch(() => {});
        if (e instanceof RenderError) throw e;
        throw new RenderError(503, 'browser unavailable'); // crash / target closed: worker retries
      }
      const pageCount = countPages(pdf);
      if (pageCount > maxPages) throw new RenderError(422, `page limit ${maxPages} exceeded`);
      rendered++;
      return { pdf: new Uint8Array(pdf), pageCount };
    } finally {
      clearTimeout(timer);
      await ctx?.close().catch(() => {});
      end();
      sinceLaunch++;
      if (sinceLaunch >= recycleAfter || rssBytes() > 0.85 * memLimit) needRecycle = true;
      release();
    }
  }

  return {
    renderHtml,
    registry,
    browser: () => browser,
    stats: () => ({ contextsBusy: busy, recycles, blockedRequests: blocked, rendered }),
    async close() {
      closed = true;
      await relaunching?.catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

export type Pool = Awaited<ReturnType<typeof createPool>>;
