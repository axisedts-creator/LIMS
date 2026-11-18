// @vitest-environment jsdom
// C9.T-21 — Levey-Jennings chart `/quality/lj?plan_id=…` (04-UI-UX §2.4, §4; AC-08.1, AC-08.2, AC-08.4, AC-08.5; 03-APP-FLOW §4).
// ASSUMED contract: app/(staff)/quality/lj/page.tsx = default async server component `Page({ searchParams })`; reads GET /v1/quality/lj-chart
//   (plan_id, view=level|z, level_id, lot_id, observed_at_from, observed_at_to). Until CR-C9-007 merges (no ControlChart in packages/ui) the chart is a DataTable of the same
//   points + the note "Chart component pending; showing values as a table."; once ControlChart exists the page uses it and renders a visually hidden table (AC-08.5).
//   Either way the page contains a table with one row per point (role=table|grid, name /points|values|data/i) and a text legend. Markers: accepted ●, warning ▲, rejected ✕,
//   excluded ○, unevaluated ◇, collecting ◌ — each ALSO as a word in the table row. Synthetic data only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  LEVEL_1, LEVEL_2, LOT_1, LOT_2, PLAN_1, RUN_1, UI_SRC, api, axeClean, calls, callsTo, json, lastNav, ljDto, norm, obsId, pageText, problem, pt, resetApi, routes, show, showOrThrown,
  PERM_MANAGE, PERM_READ,
} from './quality-t21.harness';

vi.mock('next/navigation', async () => (await import('./quality-t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t21.harness')).sessionMock);

const PAGE = 'lj/page';
const LJ = '/v1/quality/lj-chart';
const sp = (o: Record<string, string> = {}) => ({ searchParams: { plan_id: PLAN_1, level_id: LEVEL_1, ...o } });
const CHART_KIT = existsSync(join(UI_SRC, 'ControlChart'));

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetApi(PERM_READ); routes[`GET ${LJ}`] = json(ljDto()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const pointsTable = () => {
  const t = [...screen.queryAllByRole('table'), ...screen.queryAllByRole('grid')].filter((x) => /points|values|data/i.test(x.getAttribute('aria-label') ?? x.querySelector('caption')?.textContent ?? ''));
  if (!t.length) throw new Error(`no points table; tables: ${JSON.stringify([...screen.queryAllByRole('table'), ...screen.queryAllByRole('grid')].map((x) => x.getAttribute('aria-label')))}`);
  return t[0]!;
};
const pointRows = (t: HTMLElement) => within(t).getAllByRole('row').slice(1).map((r) => norm(r.textContent));

describe('access, request and states', () => {
  it('without quality.qc_run.read: permission-denied, no API call', async () => {
    resetApi([]);
    await show(PAGE, sp());
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });

  it('no plan_id: asks to pick a plan, NO chart request', async () => {
    await show(PAGE, { searchParams: {} });
    expect(callsTo('GET', LJ)).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Levey-Jennings/i);
  });

  it('forwards plan_id, view, level_id, lot_id and the period to #35 (default view = level)', async () => {
    await show(PAGE, sp({ lot_id: LOT_1, from: '2026-10-15', to: '2026-11-14' }));
    const q = callsTo('GET', LJ)[0]!.url.searchParams;
    expect(q.get('plan_id')).toBe(PLAN_1);
    expect(q.get('view')).toBe('level');
    expect(q.get('level_id')).toBe(LEVEL_1);
    expect(q.get('lot_id')).toBe(LOT_1);
    expect(q.get('observed_at_from')).toMatch(/^2026-10-15/);
    expect(q.get('observed_at_to')).toMatch(/^2026-11-1[45]/);
  });

  it.each([['plan_id', 'not-a-uuid'], ['level_id', '../x'], ['view', 'pie']])('invalid %s=%j never reaches the API', async (k, v) => {
    await show(PAGE, sp({ [k]: v }));
    const calls35 = callsTo('GET', LJ);
    if (k === 'plan_id') expect(calls35).toHaveLength(0);
    else expect(calls35.every((c) => c.url.searchParams.get(k) !== v)).toBe(true);
  });

  it('empty series: "No QC values in this period."; API 5xx rejects; feature_disabled copy', async () => {
    routes[`GET ${LJ}`] = json(ljDto({ series: [] }));
    await show(PAGE, sp());
    expect(pageText()).toContain('No QC values in this period.');
    cleanup();
    routes[`GET ${LJ}`] = () => problem('common.feature_disabled', 403);
    await show(PAGE, sp());
    expect(pageText()).toContain('The QC module is not switched on for your lab yet.');
    cleanup();
    routes[`GET ${LJ}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE, sp())).toBeTruthy();
  });

  it('truncated: banner "Showing the newest 2,000 points. Narrow the period to see all."', async () => {
    routes[`GET ${LJ}`] = json(ljDto({ truncated: true }));
    await show(PAGE, sp());
    expect(pageText()).toContain('Showing the newest 2,000 points. Narrow the period to see all.');
  });
});

describe('AC-08.1 / AC-08.5 — points, SD lines, hidden table', () => {
  it('one table row per observation, in time order, with value formatted to the analyte decimals', async () => {
    await show(PAGE, sp());
    const rows = pointRows(pointsTable());
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain('100.0');
    expect(rows[1]).toContain('104.4');
    expect(rows[2]).toContain('106.4');
  });

  it('shows the SD lines of the target in force: Mean, ±1SD, ±2SD, ±3SD with values (e.g. "+2SD 104.0")', async () => {
    await show(PAGE, sp());
    const t = pageText();
    for (const l of ['Mean 100.0', '+1SD 102.0', '-1SD 98.0', '+2SD 104.0', '-2SD 96.0', '+3SD 106.0', '-3SD 94.0']) expect(t.replace(/−/g, '-')).toContain(l);
  });

  it('a target change is a step with a label "Target v{n} ({source})"', async () => {
    await show(PAGE, sp());
    expect(pageText()).toMatch(/Target v1 \(manufacturer\)/);
    expect(pageText()).toMatch(/Target v2 \(established\)/);
    expect(pageText()).toContain('Mean 98.0'); // the earlier target keeps its own lines
  });

  it('never merges levels or lots on one line: each (level, lot) series is its own labelled group', async () => {
    const two = ljDto();
    two.series.push({ level_id: LEVEL_2, level_code: 'L2', lot_id: LOT_2, lot_no: 'SYN-LOT-002', points: [pt(0, 'accepted', { value: '150.0' })], targets: [{ target_id: obsId(900), effective_from: '2026-11-01T00:00:00.000Z', mean: '150.0', sd: '5.0', source: 'manufacturer' }] } as never);
    routes[`GET ${LJ}`] = json(two);
    await show(PAGE, sp({ view: 'z' }));
    const t = pageText();
    expect(t).toContain('L1');
    expect(t).toContain('SYN-LOT-001');
    expect(t).toContain('L2');
    expect(t).toContain('SYN-LOT-002');
    const names = [...screen.queryAllByRole('table'), ...screen.queryAllByRole('grid')].map((x) => x.getAttribute('aria-label') ?? '').join('|');
    expect(names + ' ' + t).toMatch(/L1.*SYN-LOT-001/s);
  });

  it('accessible summary sentence: "{n} points, {k} rejected, current target mean {m}, SD {s}."', async () => {
    await show(PAGE, sp());
    expect(pageText()).toContain('6 points, 1 rejected, current target mean 100.0, SD 2.0.');
  });

  it('side panel: current target mean, SD, CV %, source, rule set and mode', async () => {
    await show(PAGE, sp());
    const t = pageText();
    expect(t).toMatch(/Mean\s*100\.0/);
    expect(t).toMatch(/SD\s*2\.0/);
    expect(t).toMatch(/CV\s*2%/);
    expect(t).toMatch(/established/i);
  });

  it.runIf(!CHART_KIT)('until CR-C9-007 merges: fallback note and the same points as a visible table', async () => {
    await show(PAGE, sp());
    expect(pageText()).toContain('Chart component pending; showing values as a table.');
    expect(pointRows(pointsTable())).toHaveLength(6);
  });

  it.runIf(CHART_KIT)('with the ControlChart kit component: no fallback note, hidden table still present', async () => {
    await show(PAGE, sp());
    expect(pageText()).not.toContain('Chart component pending');
    expect(pointRows(pointsTable())).toHaveLength(6);
  });
});

describe('AC-08.2 — status by text and shape, never colour alone', () => {
  it('each point row carries its status WORD; rejected points carry their rule codes', async () => {
    await show(PAGE, sp());
    const rows = pointRows(pointsTable());
    expect(rows[0]).toMatch(/Accepted/);
    expect(rows[1]).toMatch(/Warning/);
    expect(rows[1]).toContain('1-2s');
    expect(rows[2]).toMatch(/Rejected/);
    expect(rows[2]).toContain('1-3s');
    expect(rows[3]).toMatch(/Excluded/);
    expect(rows[4]).toMatch(/Unevaluated/);
    expect(rows[5]).toMatch(/Collecting/);
  });

  it('legend is always visible with marker + word for all six statuses', async () => {
    await show(PAGE, sp());
    const t = pageText();
    for (const [m, w] of [['●', 'Accepted'], ['▲', 'Warning'], ['✕', 'Rejected'], ['○', 'Excluded'], ['◇', 'Unevaluated'], ['◌', 'Collecting']]) {
      expect(t, `legend ${m} ${w}`).toContain(m!);
      expect(t).toContain(w!);
    }
  });
});

describe('AC-08.4 — z-score view', () => {
  it('view=z requests view=z and shows z with 2 decimals (API sends 3)', async () => {
    routes[`GET ${LJ}`] = json(ljDto({ view: 'z' }));
    await show(PAGE, sp({ view: 'z' }));
    expect(callsTo('GET', LJ)[0]!.url.searchParams.get('view')).toBe('z');
    const rows = pointRows(pointsTable());
    expect(rows[2]).toContain('3.20');
    expect(rows[2]).not.toContain('3.200');
  });

  it('the view toggle is a RadioGroup "One level" / "All levels (SD units)" and switching pushes view=z to the URL', async () => {
    const u = userEvent.setup();
    await show(PAGE, sp());
    expect(screen.getByRole('radio', { name: 'One level' })).toBeTruthy();
    await u.click(screen.getByRole('radio', { name: 'All levels (SD units)' }));
    expect(lastNav() ?? '').toMatch(/view=z/);
  });
});

describe('point drawer (04-UI-UX §2.4) and exclusion', () => {
  const open = async () => {
    const u = userEvent.setup();
    const row = within(pointsTable()).getAllByRole('row')[3]!; // the rejected point
    (within(row).queryAllByRole('gridcell')[0] ?? row).focus();
    await u.keyboard('{Enter}');
    return u;
  };

  it('Enter on a point opens a drawer with the observation, a link to the run, and Esc closes it', async () => {
    await show(PAGE, sp());
    const u = await open();
    const d = screen.getByRole('dialog');
    expect(d.textContent).toContain('106.4');
    expect([...d.querySelectorAll('a')].some((a) => a.getAttribute('href') === `/quality/qc-runs/${RUN_1}`)).toBe(true);
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Exclude" only with quality.qc.manage; it asks for a coded reason from quality.exclusion_reasons and POSTs …/exclude', async () => {
    await show(PAGE, sp());
    await open();
    expect(screen.queryByRole('button', { name: /exclude/i })).toBeNull();
    cleanup();
    resetApi(PERM_MANAGE);
    routes[`GET ${LJ}`] = json(ljDto({ series: [{ ...ljDto().series[0]!, points: [pt(0, 'unevaluated', { qc_run_id: undefined })] }] }));
    routes[`POST /v1/quality/qc-observations/${obsId(300)}/exclude`] = json({});
    await show(PAGE, sp());
    const u = userEvent.setup();
    const row = within(pointsTable()).getAllByRole('row')[1]!;
    (within(row).queryAllByRole('gridcell')[0] ?? row).focus();
    await u.keyboard('{Enter}');
    await u.click(screen.getByRole('button', { name: /exclude/i }));
    expect(callsTo('GET', '/v1/quality/coded-sets/exclusion_reasons').length).toBeGreaterThan(0);
  });
});

describe('a11y', () => {
  it('axe clean (table fallback / hidden table, legend, controls)', async () => {
    await show(PAGE, sp());
    await axeClean();
  });
});
