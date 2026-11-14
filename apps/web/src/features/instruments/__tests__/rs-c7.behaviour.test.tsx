// @vitest-environment jsdom
// RS-C7 — Metro Green restyle of the C7 instrument screens (LD-140: appearance and arrangement only; 10-DESIGN-SYSTEM s3, s4, s6, s8).
// done_when: instrument list as link cards (state dot + word, last heartbeat, queue depth); message and host-query logs as tables with the existing columns; commissioning checklist as a stepper.
// ASSUMED contracts (dispute through a ruling if wrong; nothing here needs a new API, field or route):
//  A1 InstrumentsList: no <table>. One card per instrument, an <li>/<article> holding: a link to /instruments/instruments/<id> (name starts with the instrument code), the display name, the state as a kit
//     StatusChip (tone + icon + word, `.lims-chip[data-tone]`), "Last message" + a kit DateText <time>, the "N unmapped" link to /mappings, vendor/model, protocol, agent code, driver status badge, link state.
//     Every datum the old columns showed is still on screen. No card inside a card (`.lims-card .lims-card`). Sorting (E23 `sort=-last_message_at`) stays reachable from a control named /last message/i.
//  A2 "last heartbeat" and "queue depth" are AGENT data (AgentHealth); InstrumentSummary has neither, and a restyle may not add data. The instrument cards therefore show last MESSAGE; the heartbeat/queue pair
//     stays on the Agents table (guarded below). If the lead wants them on instrument cards that needs a CR (new field on the instruments list endpoint).
//  A3 Message log (SCR-09) and rejected uploads stay kit DataTables with exactly the existing column headers; there is no separate host-query log screen in this chunk (kind "Host query" is a row in the message
//     log), so none is tested: "screens that do not exist yet are out of scope".
//  A4 Commissioning checklist (SCR-07 Overview): a region named /commissioning checklist/ holding the kit StatusStepper (`.lims-stepper` <ol>) with the four existing checks as steps, in order,
//     labelled with the existing CHECK_LABELS texts; checked -> "(Complete)", the first unchecked -> "(Current)" with aria-current="step", the rest "(Upcoming)"; the old "…: yes; …: no" sentence is gone.
//  A5 Existing web-t03 test 'renders the 04-UI-UX columns' pins `columnheader`s on SCR-05 and conflicts with A1 by design (LD-140 overrides the spec text): needs a lead ruling/update, it is not edited here.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { AGENTS_PICK, CENTRES, CHECKS, DRIVERS, INST, INSTRUMENT_PICK, MANAGE, MESSAGES, ORIGIN, READ, REJECTIONS, ROWS, agentRow, full, id, summary } from './rs-c7.fixtures';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/instruments/instruments',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/instruments',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const sentCalls: string[] = [];
const api = setupServer(
  http.all(`${ORIGIN}/*`, ({ request }) => { sentCalls.push(`${request.method} ${new URL(request.url).pathname}`); return HttpResponse.json({}); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); sentCalls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
/** jsdom has no layout: colour contrast is covered by the token contrast gate, not here. */
const serious = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`);
};

const loadList = async () => (await import('../components/InstrumentsList')).InstrumentsList;
const listProps = (o: Record<string, unknown> = {}) => ({ instruments: ROWS, permissions: READ, centres: CENTRES, agents: AGENTS_PICK, drivers: DRIVERS, ...o }) as never;
const cardOf = (instId: string, code: string) => {
  const link = screen.getAllByRole('link').find((l) => l.getAttribute('href') === `/instruments/instruments/${instId}` && (l.textContent ?? '').includes(code));
  expect(link, `a link to ${code}`).toBeTruthy();
  const card = link!.closest('li, article');
  expect(card, `${code}: the link sits inside an <li> or <article> card`).toBeTruthy();
  return card as HTMLElement;
};

describe('A1 SCR-05 instruments: link cards (10-DESIGN-SYSTEM s4 Instruments)', () => {
  it('is not a table any more: no table, no column headers', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps()} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(screen.queryAllByRole('grid')).toHaveLength(0);
  });

  it('one card per instrument; the card links to SCR-07 and carries every datum the old columns showed', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps()} />);
    for (const r of ROWS) {
      const code = r.instrument_code as string;
      const card = cardOf(r.id as string, code);
      const t = card.textContent ?? '';
      expect(t, code).toContain(r.display_name as string);
      expect(t, code).toContain('Synthetic Vendor');
      expect(t, code).toContain('SV-100');
      expect(t, code).toMatch(/ASTM/);
      expect(t, code).toContain('SYN-AGENT-1');
      expect(t, code).toContain('Link state');
      expect(t, code).toMatch(/\bup\b/);
    }
    // driver status stays a word, never colour only
    expect(within(cardOf(ROWS[1]!.id as string, 'SIM-CHEM-2')).getByText('Verified')).toBeTruthy();
    expect(within(cardOf(ROWS[2]!.id as string, 'SIM-HEM-1')).getByText('Sketch — not for live use')).toBeTruthy();
    expect(within(cardOf(INST, 'SIM-CHEM-1')).getByText('Generic')).toBeTruthy();
  });

  it('state dot + word: a kit status chip (tone + icon + word) per card, with the tone of the state', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps()} />);
    const want: [string, string, string, RegExp][] = [[INST, 'SIM-CHEM-1', 'neutral', /^draft$/i], [id(0xe02), 'SIM-CHEM-2', 'success', /^live$/i], [id(0xe03), 'SIM-HEM-1', 'info', /^commissioning$/i], [id(0xe05), 'SIM-SUS-1', 'warning', /^suspended$/i]];
    for (const [i, code, tone, word] of want) {
      const chip = cardOf(i, code).querySelector('.lims-chip[data-tone]');
      expect(chip, code).toBeTruthy();
      expect(chip!.getAttribute('data-tone'), code).toBe(tone);
      expect(chip!.textContent, code).toMatch(word);
      expect(chip!.querySelector('svg'), `${code}: an icon beside the word`).toBeTruthy();
    }
    // the "no results sent" hint stays visible text on commissioning / suspended cards
    expect(cardOf(id(0xe03), 'SIM-HEM-1').textContent).toMatch(/no results sent/i);
    expect(cardOf(id(0xe05), 'SIM-SUS-1').textContent).toMatch(/no results sent/i);
  });

  it('last message: a kit date (<time>) with its label; "—" when the instrument never sent one', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps()} />);
    const a = cardOf(INST, 'SIM-CHEM-1');
    expect(a.textContent).toMatch(/Last message/i);
    expect(a.querySelector('time[datetime="2026-11-07T03:58:00.000Z"]')).toBeTruthy();
    const never = cardOf(id(0xe05), 'SIM-SUS-1');
    expect(never.textContent).toMatch(/Last message/i);
    expect(never.querySelector('time')).toBeNull();
    expect(never.textContent).toContain('—');
  });

  it('unmapped codes stay text "N unmapped" and a link to SCR-08, inside the card', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps()} />);
    const l = within(cardOf(INST, 'SIM-CHEM-1')).getByRole('link', { name: '3 unmapped' });
    expect(l.getAttribute('href')).toBe(`/instruments/instruments/${INST}/mappings`);
    expect(within(cardOf(id(0xe03), 'SIM-HEM-1')).getByRole('link', { name: '12 unmapped' })).toBeTruthy();
  });

  it('one container level and no nested interactive controls: no card in a card, no link inside a link', async () => {
    const InstrumentsList = await loadList();
    const { container } = wrap(<InstrumentsList {...listProps()} />);
    expect(container.querySelectorAll('.lims-card .lims-card')).toHaveLength(0);
    expect(container.querySelectorAll('a a, button a, a button')).toHaveLength(0);
  });

  it('behaviour unchanged: sort by last message still reachable and still navigates with sort=-last_message_at', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps()} />);
    const region = screen.getByRole('region', { name: 'Instruments' });
    const roles = ['button', 'option', 'radio', 'menuitem', 'tab', 'combobox'];
    const ctl = roles.flatMap((r) => within(region).queryAllByRole(r, { name: /last message/i }))[0];
    expect(ctl, 'a sort control whose name mentions "last message" (button / option / radio / menu item)').toBeTruthy();
    await userEvent.click(ctl!);
    const opt = screen.queryAllByRole('option', { name: /last message/i })[0];
    if (opt && opt !== ctl) await userEvent.click(opt);
    const urls = replace.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    expect(urls.some((u) => /sort=-last_message_at/.test(u)), urls.join(' | ')).toBe(true);
  });

  it('behaviour unchanged: empty state, New instrument only with manage, filters, dialog opens without a request', async () => {
    const InstrumentsList = await loadList();
    const a = wrap(<InstrumentsList {...listProps({ instruments: [] })} />);
    expect(screen.getByText('No instruments registered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new instrument/i })).toBeNull();
    a.unmount();
    wrap(<InstrumentsList {...listProps({ permissions: MANAGE })} />);
    expect(within(screen.getByRole('search')).getByText('Protocol', { selector: 'label, .lims-label, span' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /new instrument/i }).length, 'one primary action per page: the header button').toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole('button', { name: /new instrument/i })[0]!);
    expect(within(screen.getByRole('dialog')).getByLabelText(/^code/i)).toBeTruthy();
    expect(sentCalls).toEqual([]);
  });

  it('SECURITY: names are text, never HTML, on the cards', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps({ instruments: [summary({ display_name: '<img src=x onerror=alert(1)>', vendor: '<script>alert(1)</script>' })] })} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('keyboard only: Tab reaches each card link and its unmapped link in order; Enter on a card link is a link activation (no script handler)', async () => {
    const InstrumentsList = await loadList();
    wrap(<InstrumentsList {...listProps({ instruments: [ROWS[0]!, ROWS[1]!] })} />);
    const user = userEvent.setup();
    const seen: string[] = [];
    for (let i = 0; i < 60 && seen.length < 4; i++) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      if (el.tagName === 'A' && el.getAttribute('href')!.startsWith('/instruments/instruments/')) seen.push(el.getAttribute('href')!);
    }
    expect(seen).toEqual([`/instruments/instruments/${INST}`, `/instruments/instruments/${INST}/mappings`, `/instruments/instruments/${id(0xe02)}`, `/instruments/instruments/${id(0xe02)}/mappings`]);
    const first = screen.getAllByRole('link').find((l) => l.getAttribute('href') === `/instruments/instruments/${INST}`)!;
    expect(first.getAttribute('role')).toBeNull();
    expect(first.getAttribute('tabindex')).toBeNull();
  });

  it('axe (serious/critical): populated, empty, with the create dialog open', async () => {
    const InstrumentsList = await loadList();
    const a = wrap(<InstrumentsList {...listProps({ permissions: MANAGE })} />);
    expect(await serious()).toEqual([]);
    await userEvent.click(screen.getAllByRole('button', { name: /new instrument/i })[0]!);
    expect(await serious()).toEqual([]);
    a.unmount();
    wrap(<InstrumentsList {...listProps({ instruments: [], permissions: MANAGE })} />);
    expect(await serious()).toEqual([]);
  });
});

describe('A2 SCR-01 agents: heartbeat and queue depth stay visible (guard, existing columns)', () => {
  it('Last heartbeat and Queue are still shown per agent with their values (table or card), with the health word', async () => {
    const { AgentsList } = await import('../components/AgentsList');
    wrap(<AgentsList agents={[agentRow(1), agentRow(2, { health: { state: 'backlog', last_heartbeat_at: '2026-11-07T03:50:00.000Z', queue_depth: 130, oldest_pending_age_seconds: 900 } })] as never} permissions={READ} centres={CENTRES} />);
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/Last heartbeat/i);
    expect(t).toMatch(/Queue/i);
    expect(t).toContain('Online');
    expect(t).toContain('Backlog');
    expect(document.querySelector('time[datetime="2026-11-07T03:59:00.000Z"]')).toBeTruthy();
    expect(t).toContain('130');
    expect(await serious()).toEqual([]);
  });
});

describe('A3 SCR-09 messages: logs stay tables with the existing columns (10-DESIGN-SYSTEM s4)', () => {
  const show = async () => {
    const { MessagesList } = await import('../components/MessagesList');
    return wrap(<MessagesList messages={MESSAGES as never} rejections={REJECTIONS as never} instruments={INSTRUMENT_PICK as never} agents={AGENTS_PICK as never} permissions={READ} />);
  };
  it('message log: a table named Messages with the eight existing columns, kind words and outcome chips (tone + icon + word)', async () => {
    await show();
    // ruling: the kit DataTable is an ARIA grid (04-UI-UX.md:214), caption = accessible name (04-UI-UX.md:196)
    const table = screen.getByRole('grid', { name: /^messages$/i });
    for (const h of ['Received', 'Instrument', 'Kind', 'Records (patient / QC)', 'Unmapped', 'Events', 'Outcome', 'Size'])
      expect(within(table).getByRole('columnheader', { name: h }), h).toBeTruthy();
    const host = within(table).getByRole('row', { name: /Host query/ });
    expect(host).toBeTruthy();
    expect(within(table).getAllByRole('row').length).toBe(1 + MESSAGES.length);
    const chips = [...table.querySelectorAll('.lims-chip[data-tone]')];
    expect(chips.length).toBeGreaterThanOrEqual(MESSAGES.length);
    for (const c of chips) {
      expect(c.textContent!.trim().length, 'a word in every status chip').toBeGreaterThan(0);
      expect(c.querySelector('svg'), 'an icon in every status chip').toBeTruthy();
    }
    expect(within(table).getAllByRole('link').map((l) => l.getAttribute('href'))).toContain(`/instruments/messages/${MESSAGES[0]!.id}`);
  });

  it('rejected uploads: a table with the five existing columns', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: 'Rejected uploads' }));
    const table = screen.getByRole('grid', { name: /rejected uploads/i });
    for (const h of ['Received', 'Agent', 'Claimed instrument', 'Reason', 'Size']) expect(within(table).getByRole('columnheader', { name: h }), h).toBeTruthy();
    expect(within(table).getByText('instruments.device_mismatch')).toBeTruthy();
  });

  it('behaviour unchanged: filters, the barcode search and the "/" shortcut; one request path only (the existing search action)', async () => {
    await show();
    const bar = screen.getByRole('search');
    for (const l of ['Received', 'Instrument', 'Agent', 'Kind', 'Latest outcome']) expect(within(bar).getByText(l, { selector: 'label, .lims-label, span' }), l).toBeTruthy();
    expect(screen.getByLabelText('Barcode')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Has QC records' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Has unmapped codes' })).toBeTruthy();
    const sc = (await import('@/core/shortcuts/registry')).shortcuts.list('staff.instruments.messages').find((s) => s.key === '/');
    expect(sc?.description).toBe('Search by scanned barcode');
    act(() => sc!.run());
    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(sentCalls).toEqual([]);
  });

  it('keyboard only: Tab reaches the tabs, the barcode field and the Messages grid; arrow keys then reach the first message link; no mouse', async () => {
    await show();
    const user = userEvent.setup();
    const grid = screen.getByRole('grid', { name: /^messages$/i });
    const seen = new Set<string>();
    for (let i = 0; i < 80 && !grid.contains(document.activeElement); i++) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      if (el.getAttribute('role') === 'tab') seen.add(`tab:${el.textContent}`);
      if (el.tagName === 'INPUT' && el.getAttribute('name') === 'search') seen.add('barcode');
    }
    expect([...seen]).toEqual(expect.arrayContaining(['tab:Messages', 'barcode']));
    expect(grid.contains(document.activeElement), 'Tab moves focus into the Messages grid').toBe(true);
    // ruling: 04-UI-UX.md:214 "Tab enters the grid. Arrow keys move between cells."
    const href = `/instruments/messages/${MESSAGES[0]!.id}`;
    const onLink = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.getAttribute('href') === href || !!a.querySelector(`a[href="${href}"]`) || a.closest(`a[href="${href}"]`) !== null);
    };
    const keys = ['{ArrowDown}', '{ArrowRight}'];
    for (let i = 0; i < 20 && !onLink(); i++) await user.keyboard(keys[i % 2]!);
    expect(onLink(), 'arrow keys move focus to the first message link (or its cell)').toBe(true);
  });

  it('axe (serious/critical): both tabs', async () => {
    await show();
    expect(await serious()).toEqual([]);
    await userEvent.click(screen.getByRole('tab', { name: 'Rejected uploads' }));
    expect(await serious()).toEqual([]);
  });
});

describe('A4 SCR-07 commissioning checklist as a stepper (10-DESIGN-SYSTEM s4 Instruments)', () => {
  const show = async (o: Record<string, unknown> = {}, permissions: readonly string[] = MANAGE) => {
    const { InstrumentDetail } = await import('../components/InstrumentDetail');
    return wrap(<InstrumentDetail instrument={full(o) as never} agents={AGENTS_PICK as never} drivers={DRIVERS as never} permissions={permissions} />);
  };
  const stepsOf = () => {
    const region = screen.getByRole('region', { name: /commissioning checklist/i });
    const stepper = region.querySelector('.lims-stepper');
    expect(stepper, 'the kit StatusStepper inside the region').toBeTruthy();
    const items = [...stepper!.querySelectorAll('ol > li')] as HTMLElement[];
    return { region, items };
  };
  const partial = { manual_reference_confirmed: true, sample_comparison_done: true, qc_comparison_done: false, mappings_reviewed: false };

  it('a partly done checklist: two steps Complete, the next one Current (aria-current="step"), the last Upcoming, in the existing wording and order', async () => {
    await show({ state: 'commissioning', go_live_checklist: partial });
    const { items } = stepsOf();
    const order = Object.values(CHECKS);
    const mine = order.map((label) => items.find((li) => (li.textContent ?? '').includes(label)));
    mine.forEach((li, i) => expect(li, order[i]).toBeTruthy());
    expect(items.indexOf(mine[0]!)).toBeLessThan(items.indexOf(mine[1]!));
    expect(items.indexOf(mine[1]!)).toBeLessThan(items.indexOf(mine[2]!));
    expect(items.indexOf(mine[2]!)).toBeLessThan(items.indexOf(mine[3]!));
    expect(mine[0]!.textContent).toMatch(/\(Complete\)/);
    expect(mine[1]!.textContent).toMatch(/\(Complete\)/);
    expect(mine[2]!.textContent).toMatch(/\(Current\)/);
    expect(mine[2]!.getAttribute('aria-current')).toBe('step');
    expect(mine[3]!.textContent).toMatch(/\(Upcoming\)/);
    expect(mine.filter((li) => li!.getAttribute('aria-current') === 'step')).toHaveLength(1);
  });

  it('a finished checklist: all four steps Complete; a missing checklist: all four not Complete (nothing claimed)', async () => {
    const a = await show({ state: 'live', live_at: '2026-11-06T04:00:00.000Z', live_by_display: 'Synthetic Manager', go_live_checklist: Object.fromEntries(Object.keys(CHECKS).map((k) => [k, true])) });
    for (const label of Object.values(CHECKS)) expect(stepsOf().items.find((li) => li.textContent!.includes(label))!.textContent, label).toMatch(/\(Complete\)/);
    a.unmount();
    await show({ state: 'draft', go_live_checklist: undefined });
    for (const label of Object.values(CHECKS)) expect(stepsOf().items.find((li) => li.textContent!.includes(label))!.textContent, label).not.toMatch(/\(Complete\)/);
  });

  it('the old sentence ("…: yes; …: no") is gone; the rest of Overview (link state, driver, went live) is still there', async () => {
    await show({ state: 'live', driver_code: 'astm_verified_x', driver_status: 'verified', live_at: '2026-11-06T04:00:00.000Z', live_by_display: 'Synthetic Manager', go_live_checklist: partial });
    expect(document.body.textContent).not.toMatch(/: (yes|no);/);
    for (const term of ['Link state', 'Last message (server)', 'Driver', 'Driver version', 'Went live']) expect(document.body.textContent, term).toContain(term);
    expect(document.body.textContent).toContain('Synthetic Manager');
  });

  it('behaviour unchanged: Go live still opens the four-check dialog, nothing is sent until submit; read-only users get no action', async () => {
    await show({ state: 'commissioning', driver_code: 'astm_verified_x', driver_status: 'verified' });
    const user = userEvent.setup();
    const go = screen.getByRole('button', { name: /^go live$/i });
    go.focus();
    await user.keyboard('{Enter}');
    const dlg = screen.getByRole('dialog');
    for (const label of Object.values(CHECKS)) expect(within(dlg).getByLabelText(label), label).toBeTruthy();
    expect(within(dlg).getByLabelText(/evidence note/i)).toBeTruthy();
    expect(sentCalls).toEqual([]);
    cleanup();
    await show({ state: 'commissioning' }, READ);
    expect(screen.queryByRole('button', { name: /go live|start commissioning|suspend|resume|retire/i })).toBeNull();
  });

  it('one primary button per page: the header holds at most one primary action', async () => {
    const { container } = await show({ state: 'commissioning' });
    expect(container.querySelectorAll('.lims-btn-primary, [data-variant="primary"]').length).toBeLessThanOrEqual(1);
  });

  it('axe (serious/critical): overview with a partial, a complete and an absent checklist; configuration and history tabs', async () => {
    const a = await show({ state: 'commissioning', go_live_checklist: partial });
    expect(await serious()).toEqual([]);
    await userEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    expect(await serious()).toEqual([]);
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await serious()).toEqual([]);
    a.unmount();
    await show({ state: 'live', go_live_checklist: Object.fromEntries(Object.keys(CHECKS).map((k) => [k, true])) });
    expect(await serious()).toEqual([]);
    cleanup();
    await show({ state: 'draft', go_live_checklist: undefined });
    expect(await serious()).toEqual([]);
  });
});
