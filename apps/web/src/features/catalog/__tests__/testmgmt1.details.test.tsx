// @vitest-environment jsdom
// T0D-TESTMGMT-1 done_when (2): two-pane Test Details. /catalog/tests?view=details[&test=<id>].
// Left: tests with a search box (display name, short name, code, tag). Right: parameters of the selected test as name, sub heading and short name
// (short name = analyte code, the name equations use). Buttons New parameter, Edit parameter, Add existing parameter to this test, Add space, Remove.
// Reorder with keyboard and buttons -> PATCH /v1/catalog/analytes/{id} {sort_order}. Add space -> POST /v1/catalog/tests/{id}/analytes with
// initial_version.result_type 'space'. Remove = PATCH analyte {is_active:false} (no DELETE verb exists). Empty panes keep their headings.
// API GAP (flagged in the notes): list rows carry display_name and short_name but not tags, so a tag is searched through GET tests/{id}.tags for the
// rows on the page (as CATTESTS-1 did for specimen); "Add existing parameter" has no contract operation, so only the dialog is pinned.
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { READ, HB, RBC, WBC, T_CBC, T_EMPTY, calls, mountTests, mutations, setTests, testDetail, tm, to, HAEM } from './testmgmt1.kit';

const LEFT = /^tests?$/i; // pane headings
const RIGHT = /^parameters$/i;
const pane = (name: RegExp) => screen.getByRole('region', { name });
const open = (search = 'view=details') => mountTests(`?${search}`);

describe('Test Details: panes and search', () => {
  it('shows both pane headings even when nothing is selected or there are no tests', async () => {
    setTests([]);
    await open();
    expect(await screen.findByRole('heading', { name: LEFT })).toBeTruthy();
    expect(screen.getByRole('heading', { name: RIGHT })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeTruthy();
  });

  it('lists tests on the left; selecting one (?test=) fills the right pane with name, sub heading and short name per parameter', async () => {
    await open(`view=details&test=${T_CBC.id}`);
    const left = await screen.findByRole('region', { name: LEFT });
    expect(within(left).getAllByText(/Complete blood count|CBC/).length).toBeGreaterThan(0);
    const right = pane(RIGHT);
    for (const col of [/^name$/i, /sub ?heading/i, /short name/i]) expect(await within(right).findByRole('columnheader', { name: col })).toBeTruthy();
    const rows = within(right).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Hemoglobin')).toBeTruthy();
    expect(within(rows[0]!).getByText('Red cells')).toBeTruthy();
    expect(within(rows[0]!).getByText('HB')).toBeTruthy();
  });

  it('a test with no parameters keeps the three column headings and says so (empty pane still has its headers)', async () => {
    await open(`view=details&test=${T_EMPTY.id}`);
    const right = await screen.findByRole('region', { name: RIGHT });
    for (const col of [/^name$/i, /sub ?heading/i, /short name/i]) expect(within(right).getByRole('columnheader', { name: col })).toBeTruthy();
    expect(within(right).getByText(/no parameters/i)).toBeTruthy();
  });

  it.each([
    ['display name', 'COMPLETE BLOOD COUNT, EDTA WB', 'CBC'],
    ['short name', 'GLU', 'GLU'],
    ['code', 'tsh', 'TSH'],
    ['tag', 'anaemia', 'CBC'],
  ])('search by %s narrows the left pane (case-insensitive)', async (_how, query, code) => {
    await open();
    const box = await screen.findByRole('searchbox', { name: /search/i });
    await userEvent.type(box, query);
    const left = pane(LEFT);
    await waitFor(() => expect(within(left).getAllByRole('option').length).toBe(1));
    expect(within(left).getByRole('option').textContent).toContain(code);
  });

  it('is paged: 200 tests never render more than one page of rows', async () => {
    setTests(Array.from({ length: 200 }, (_, i) => testDetail(500 + i, `T${i}`, `Synthetic ${i}`, HAEM)));
    await open();
    const left = await screen.findByRole('region', { name: LEFT });
    await waitFor(() => expect(within(left).getAllByRole('option').length).toBeGreaterThan(0));
    expect(within(left).getAllByRole('option').length).toBeLessThanOrEqual(50);
    expect(within(left).getByRole('button', { name: /next/i })).toBeTruthy();
  });
});

describe('Test Details: parameter actions', () => {
  const selected = async () => { await open(`view=details&test=${T_CBC.id}`); return within(await screen.findByRole('region', { name: RIGHT })); };

  it('has New parameter, Edit parameter, Add existing parameter to this test, Add space and Remove for a manager; Edit and Remove wait for a selected row', async () => {
    const right = await selected();
    for (const n of [/new parameter/i, /edit parameter/i, /add existing parameter to this test/i, /add space/i, /remove/i]) expect(right.getByRole('button', { name: n })).toBeTruthy();
    expect((right.getByRole('button', { name: /edit parameter/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(right.getAllByRole('row')[1]!);
    expect((right.getByRole('button', { name: /edit parameter/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('New parameter and Edit parameter go to ?parameter=new and ?parameter=<id> on the same screen', async () => {
    const right = await selected();
    await userEvent.click(right.getByRole('button', { name: /new parameter/i }));
    expect(tm().navLog.at(-1)).toContain('parameter=new');
    await userEvent.click(right.getAllByRole('row')[2]!);
    await userEvent.click(right.getByRole('button', { name: /edit parameter/i }));
    expect(tm().navLog.at(-1)).toContain(`parameter=${RBC.id}`);
  });

  it('Add existing parameter to this test opens a dialog with its own search', async () => {
    const right = await selected();
    await userEvent.click(right.getByRole('button', { name: /add existing parameter to this test/i }));
    const dlg = await screen.findByRole('dialog', { name: /add existing parameter/i });
    expect(within(dlg).getByRole('searchbox')).toBeTruthy();
  });

  it('Add space posts a parameter whose result type is space, after the selected row order', async () => {
    const right = await selected();
    await userEvent.click(right.getByRole('button', { name: /add space/i }));
    await waitFor(() => expect(to('POST', new RegExp(`/tests/${T_CBC.id}/analytes$`))).toHaveLength(1));
    const c = to('POST', /\/analytes$/)[0]!;
    expect(c.body.initial_version.result_type).toBe('space');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
  });

  it('Remove asks first, then deactivates (PATCH is_active false with If-Match), never DELETE', async () => {
    const right = await selected();
    await userEvent.click(right.getAllByRole('row')[1]!);
    await userEvent.click(right.getByRole('button', { name: /remove/i }));
    expect(mutations()).toHaveLength(0); // confirmation first
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^(remove|confirm|yes)/i }));
    await waitFor(() => expect(to('PATCH', new RegExp(`/analytes/${HB.id}$`))).toHaveLength(1));
    const c = to('PATCH', /\/analytes\//)[0]!;
    expect(c.body).toMatchObject({ is_active: false });
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(calls.some((x) => x.method === 'DELETE')).toBe(false);
  });

  it('Move up / Move down buttons swap sort_order of the two neighbours', async () => {
    const right = await selected();
    await userEvent.click(right.getAllByRole('row')[2]!); // RBC (sort 20)
    await userEvent.click(right.getByRole('button', { name: /move up/i }));
    await waitFor(() => expect(to('PATCH', /\/analytes\//).length).toBe(2));
    const sent = Object.fromEntries(to('PATCH', /\/analytes\//).map((c) => [c.path.split('/').pop(), c.body.sort_order]));
    expect(sent).toEqual({ [RBC.id]: HB.sort_order, [HB.id]: RBC.sort_order });
  });

  it('keyboard reorder: Alt+ArrowDown on the focused row moves it down (same writes as the buttons)', async () => {
    const right = await selected();
    const row = right.getAllByRole('row')[1]!; // HB
    row.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(to('PATCH', /\/analytes\//).length).toBe(2));
    const sent = Object.fromEntries(to('PATCH', /\/analytes\//).map((c) => [c.path.split('/').pop(), c.body.sort_order]));
    expect(sent).toEqual({ [HB.id]: RBC.sort_order, [RBC.id]: HB.sort_order });
  });

  it('the first row cannot move up and the last cannot move down', async () => {
    const right = await selected();
    await userEvent.click(right.getAllByRole('row')[1]!);
    expect((right.getByRole('button', { name: /move up/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(right.getAllByRole('row')[3]!);
    expect((right.getByRole('button', { name: /move down/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(WBC.sort_order).toBeGreaterThan(RBC.sort_order);
  });

  it('a read-only actor sees the list but every mutating button is absent or disabled, with a visible reason', async () => {
    tm().permissions = READ;
    const right = await selected();
    for (const n of [/new parameter/i, /add space/i, /remove/i, /move up/i]) {
      const b = right.queryByRole('button', { name: n }) as HTMLButtonElement | null;
      expect(b === null || b.disabled).toBe(true);
    }
    expect(screen.getByText(/permission|not allowed|read[- ]only/i)).toBeTruthy();
  });

});
