// @vitest-environment jsdom
// RS-C4 — Register screen restyle (LD-140; 10-DESIGN-SYSTEM s3 "one primary per page", s4 "Register", s6, s8). Behaviour is unchanged, arrangement is not.
// Harness: fd-t13.harness.tsx (MSW plays the API). Contract the writer must meet (jsdom has no layout engine, so it is expressed in DOM + CSS source):
//  - three sections, h2 headings exactly "Patient", "Tests", "Billing", stacked in ONE left column (no other h2 between them, nothing from the summary inside it);
//  - a sticky summary `<aside aria-label="Registration summary">` AFTER them in DOM order, labelled rows: Tests (names/count), Total, Paid, Balance, Discount authority.
//    Its class carries a CSS rule `position: sticky` in kit.css or a .css file under features/frontdesk (tokens only).
//  - Discount authority row shows the quote's own limit (discount_evaluation.limit_percent_bp / 100 %) and says "approval" when approval_required: no new data.
//  - New patient: keep both the date-of-birth field and the three age fields (the field model is "either, not both"), grouped in ONE nested role=group
//    named /age or date of birth/i that holds no other field. Field names unchanged (birth_on, age_years, age_months, age_days).
//  - One primary button at any time (Register & print); "Use this new patient" becomes secondary. No "Save draft" action is added.
//  - Keyboard path and shortcuts unchanged; axe: zero serious/critical.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { HttpResponse, MONEY, PATH, UNIT, handlers, of, quoteFor, renderForm, result, setup } from './fd-t13.harness';
import { walk, web } from './rs-c4.signature';

setup();
const T = 4000;
const kitCss = join(web, '..', '..', 'packages', 'ui', 'src', 'components', 'kit.css');

const patientSearch = () => screen.getByRole('combobox', { name: /search (patient|name)/i });
const seriousOrCritical = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const summary = () => screen.getByRole('complementary', { name: /registration summary/i });
const valueOf = (aside: HTMLElement, label: RegExp) => {
  const l = within(aside).getByText(label);
  return (l.nextElementSibling ?? l.parentElement)!.textContent ?? '';
};
/** returning patient + CBC, quote answered */
async function fillOne(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{F2}9841000001');
  await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T });
  await user.keyboard('{Enter}');
  await screen.findByText(/P-000123/, undefined, { timeout: T });
  await user.keyboard('{F4}CBC');
  await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
  await user.keyboard('{Enter}');
  await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.items).toHaveLength(1), { timeout: T });
  await screen.findAllByText(MONEY(UNIT), undefined, { timeout: T });
}

describe('s4 Register: Patient, Tests, Billing stacked left; sticky summary right', () => {
  it('h2 sections are exactly Patient, Tests, Billing, in that order', async () => {
    await renderForm();
    const main = screen.getByRole('region', { name: /new registration/i });
    const h2 = within(main).getAllByRole('heading', { level: 2 }).filter((h) => !summary().contains(h));
    expect(h2.map((h) => h.textContent?.trim())).toEqual(['Patient', 'Tests', 'Billing']);
  });

  it('the three sections share one column and the summary is outside it, after it', async () => {
    await renderForm();
    const [p, t, b] = ['Patient', 'Tests', 'Billing'].map((n) => screen.getByRole('heading', { level: 2, name: n }));
    const aside = summary();
    let lca: HTMLElement | null = p!.parentElement;
    while (lca && !(lca.contains(t!) && lca.contains(b!))) lca = lca.parentElement;
    expect(lca).toBeTruthy();
    expect(lca!.contains(aside)).toBe(false); // the left column holds the three sections and nothing of the summary
    expect(aside.parentElement!.contains(lca!)).toBe(true); // ...and the summary sits beside that column
    expect(p!.compareDocumentPosition(t!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(t!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(b!.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // stacked, not a card inside a card (s6): no section heading inside another section's container
    for (const h of [p!, t!, b!]) expect(h.closest('.lims-card')?.querySelector('.lims-card')).toBeNull();
  });

  it('summary has rows Tests, Total, Paid, Balance, Discount authority; they follow the quote and the typed payment', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await fillOne(user);
    const aside = summary();
    expect(aside.textContent).toMatch(/CBC|Complete blood count/);
    expect(within(aside).getAllByText(/^tests?\b/i).length).toBeGreaterThan(0);
    expect(valueOf(aside, /^total$/i)).toMatch(MONEY(UNIT));
    expect(valueOf(aside, /^paid$/i)).toMatch(MONEY(UNIT)); // payment row is prefilled with the net
    expect(valueOf(aside, /^balance( due)?$/i)).toMatch(MONEY(0));
    expect(valueOf(aside, /^discount authority$/i)).toMatch(/5\s*%/); // limit_percent_bp 500 from the quote

    const amount = screen.getAllByRole('textbox', { name: /^amount/i })[0]!;
    await user.clear(amount);
    await user.type(amount, '50');
    await waitFor(() => expect(valueOf(summary(), /^paid$/i)).toMatch(MONEY(5000)), { timeout: T });
    expect(valueOf(summary(), /^balance( due)?$/i)).toMatch(MONEY(UNIT - 5000));
    expect(valueOf(summary(), /^total$/i)).toMatch(MONEY(UNIT)); // total does not move with the payment
  });

  it('Discount authority says approval is needed when the quote requires it (no new data)', async () => {
    handlers.quote = async (b) => HttpResponse.json(quoteFor(b, { discount_evaluation: { within_limit: false, approval_required: true, limit_percent_bp: 500, limit_paisa: 0 } }));
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await fillOne(user);
    expect(valueOf(summary(), /^discount authority$/i)).toMatch(/approval/i);
    expect(valueOf(summary(), /^discount authority$/i)).toMatch(/5\s*%/);
  });

  it('the summary is sticky: its class has a position: sticky rule in kit.css or a feature .css file', async () => {
    await renderForm();
    const classes = [...summary().classList];
    expect(classes.length).toBeGreaterThan(0);
    const cssFiles = [kitCss, ...walk(join(web, 'src', 'features', 'frontdesk')).filter((f) => f.endsWith('.css'))];
    const css = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    const sticky = classes.some((c) => new RegExp(`\\.${c}(?![\\w-])[^{}]*\\{[^}]*position\\s*:\\s*sticky`).test(css));
    expect(sticky, `no "position: sticky" rule for .${classes.join(' / .')}`).toBe(true);
    // tokens only: the offset below the 56 px top bar comes from a var(), not a literal pixel value
    const rule = css.match(new RegExp(`\\.(?:${classes.join('|')})(?![\\w-])[^{}]*\\{([^}]*position\\s*:\\s*sticky[^}]*)\\}`))?.[1] ?? '';
    expect(rule).toMatch(/top\s*:\s*(?:0|var\()/);
  });
});

describe('s4 Register: actions', () => {
  it('exactly one primary button ("Register & print"); no draft feature is added; secondary actions are not primary', async () => {
    await renderForm();
    const primaries = [...document.querySelectorAll('button.lims-btn-primary')];
    expect(primaries.map((b) => b.textContent?.replace(/Ctrl\+Enter/, '').trim())).toEqual(['Register & print']);
    expect(screen.queryByRole('button', { name: /draft/i })).toBeNull();
    for (const n of [/^new patient/i, /^discount/i, /^add method/i, /^shortcuts/i]) {
      const b = screen.getByRole('button', { name: n });
      expect(b.className).not.toMatch(/lims-btn-primary/);
    }
  });

  it('with the new-patient form open there is still one primary button (Register & print); "Use this new patient" is secondary', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{Alt>}n{/Alt}');
    await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    const primaries = [...document.querySelectorAll('button.lims-btn-primary')].map((b) => b.textContent?.replace(/Ctrl\+Enter/, '').trim());
    expect(primaries).toEqual(['Register & print']);
    expect(screen.getByRole('button', { name: /use this new patient/i }).className).not.toMatch(/lims-btn-primary/);
  });
});

describe('s4 Register: age and date of birth', () => {
  it('both are kept (field model is "either, not both") but grouped in one labelled group that holds nothing else', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{Alt>}n{/Alt}');
    const form = await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    const groups = within(form).getAllByRole('group').filter((g) => g !== form && /age or date of birth|date of birth or age|age.*birth|birth.*age/i.test(g.getAttribute('aria-label') ?? g.querySelector('legend')?.textContent ?? ''));
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    for (const n of [/age years/i, /age months/i, /age days/i]) expect(within(g).getByRole('spinbutton', { name: n })).toBeTruthy();
    expect(within(g).getAllByText(/date of birth/i).length).toBeGreaterThan(0);
    // nothing unrelated inside: name, mobile, email, address stay outside
    for (const n of [/full name/i, /^mobile/i, /^email/i, /^address/i]) expect(within(g).queryByRole('textbox', { name: n })).toBeNull();
    // field names untouched
    for (const n of ['age_years', 'age_months', 'age_days']) expect(form.querySelector(`[name="${n}"]`), n).toBeTruthy();
  });

  it('the either-or rule still holds: both entered shows the same error and does not use the patient', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{Alt>}n{/Alt}');
    const form = await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    await user.type(within(form).getByRole('textbox', { name: /full name/i }), 'Synthetic New Person');
    await user.click(within(form).getByRole('radio', { name: /^female$/i }));
    await user.type(within(form).getByRole('spinbutton', { name: /age years/i }), '30');
    await user.keyboard('{Tab}');
    await user.click(within(form).getByRole('checkbox', { name: /processing of my data/i }));
    await user.click(within(form).getByRole('button', { name: /use this new patient/i }));
    expect(within(form).queryByText(/either a date of birth or an age, not both/i)).toBeNull(); // only age given: accepted
    await waitFor(() => expect(screen.queryByRole('group', { name: /^new patient$/i })).toBeNull(), { timeout: T });
    expect(screen.getByText(/Synthetic New Person/)).toBeTruthy();
  });
});

describe('s8 keyboard-only path through the main task (unchanged shortcuts)', () => {
  it('F2 search · Enter · F4 CBC Enter · F8 amount · Ctrl+Enter registers once; zero pointer events; summary shows the net', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    const pointer: string[] = [];
    for (const t of ['click', 'mousedown', 'pointerdown']) document.addEventListener(t, () => pointer.push(t), true);
    expect(document.activeElement).toBe(patientSearch());
    await fillOne(user);
    await user.keyboard('{F8}');
    expect((document.activeElement as HTMLInputElement).tagName).toBe('INPUT');
    expect((document.activeElement as HTMLInputElement).value.replace(/,/g, '')).toBe('113.00');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const reg = of('POST', PATH.register)[0]!;
    expect(reg.body).toMatchObject({ patient: { patient_id: expect.any(String) }, visit_type: 'opd', billing_mode: 'cash', payments: [{ method_code: 'cash', amount_received_paisa: UNIT }] });
    expect(reg.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(pointer).toEqual([]);
  });

  it('Alt+C toggles cash/credit, ? opens the shortcut list with the s3.5 keys', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{Alt>}c{/Alt}');
    expect(screen.getByRole('radio', { name: /^credit$/i })).toHaveProperty('checked', true);
    await user.keyboard('{Alt>}c{/Alt}');
    expect(screen.getByRole('radio', { name: /^cash$/i })).toHaveProperty('checked', true);
    (document.activeElement as HTMLElement).blur(); // '?' typed in a text field is text, not a shortcut (fd-t13)
    await user.keyboard('?');
    const dlg = await screen.findByRole('dialog', { name: /keyboard shortcuts/i }, { timeout: T });
    const keys = within(dlg).getAllByText((_, el) => el?.tagName === 'KBD').map((k) => k.textContent!.replace(/\s/g, ''));
    for (const k of ['F2', 'Alt+N', 'F3', 'Alt+D', 'F4', 'Del', 'U', 'Alt+R', 'Alt+O', 'Alt+I', 'Alt+C', 'F6', 'Alt+A', 'F8', 'Alt+P', 'Alt+U', 'Ctrl+Enter', 'Ctrl+Shift+N', 'Alt+L', 'Esc', '?']) {
      expect(keys.some((x) => x.includes(k)), `shortcut ${k} listed`).toBe(true);
    }
  });
});

describe('s8 axe: zero serious/critical on the register screen', () => {
  it('blank, populated, and with the new-patient form open', async () => {
    const user = userEvent.setup({ delay: null });
    const view = await renderForm();
    await seriousOrCritical();
    await fillOne(user);
    await seriousOrCritical();
    view.unmount();
    await renderForm();
    await userEvent.setup({ delay: null }).keyboard('{Alt>}n{/Alt}');
    await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    await seriousOrCritical();
  });

  it('success panel after Register', async () => {
    handlers.register = async () => HttpResponse.json(result(), { status: 201 });
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await fillOne(user);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByText(/R-2083-000042/, undefined, { timeout: T });
    await seriousOrCritical();
  });
});
