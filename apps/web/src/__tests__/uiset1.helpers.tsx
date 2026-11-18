// T0D-UISETTINGS-1 shared assertions (tester-owned helper, not a test file). LD-353 template 4 SETTINGS + rules 2, 3, 6, 8, read from the DOM only.
// The kit SettingsForm (T0D-UIKIT-1) draws: div.lims-settings > div.lims-settings-tabs (only with tabs) + form.lims-settings-form > div.lims-settings-fields + div.lims-settings-bar (last, one submit "Save").
// Widths, two columns and the sticky bar are kit CSS (pinned by uikit1.panels); jsdom has no layout, so a screen proves it by USING the kit form, once, with no own box layout.
import { expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { menuLabel } from './uilist1.helpers';

export { menuLabel, expectNotAvailable, expectErrorState } from './uilist1.helpers';

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const q = (root: ParentNode, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];

/** Tab elements of the screen: kit Tabs (role=tab) or a link/nav list inside the SettingsForm tabs slot. */
export const tabEls = (root: ParentNode) => q(root, '.lims-settings-tabs [role="tab"], .lims-settings-tabs nav a');
export const tabNames = (root: ParentNode) => tabEls(root).map((t) => norm(t.textContent));

const fieldNames = (root: ParentNode) => q(root, '.lims-settings-fields [name]').map((e) => e.getAttribute('name')!).filter(Boolean);
const labelTexts = (root: ParentNode) => [
  ...q(root, '.lims-settings-fields label, .lims-settings-fields .lims-label, .lims-settings-fields legend').map((l) => norm(l.textContent)),
  ...q(root, '.lims-settings-fields [aria-label]').map((l) => l.getAttribute('aria-label') ?? ''),
];

export interface SettingsExpect {
  /** route of the screen: the h1 must equal its ElabAssist menu label (rule 8). */
  path: string;
  /** exact tab names (several sections = tabs); `include` for screens whose tab set is partly dynamic. Omit for a one-section screen: then NO tabs. */
  tabs?: readonly string[] | { include: readonly string[]; min?: number };
  /** `name` attributes that must exist across all tabs (field names stay, none removed). */
  names?: readonly string[];
  /** label patterns that must exist across all tabs (for forms whose inputs carry no name attribute). */
  labels?: readonly RegExp[];
  /** click every role=tab and union the fields (client tabs). Default true when tabs are given. */
  unionTabs?: boolean;
  /** Cards are boxes (rule 3): none allowed inside the fields. Default true. */
  noCards?: boolean;
}

/** LD-353 template 4 contract for ONE rendered, editable settings screen. */
export async function expectSettingsForm(container: HTMLElement, o: SettingsExpect): Promise<void> {
  const where = o.path;
  expect(q(container, 'h1').map((h) => norm(h.textContent)), `${where}: one h1 = the menu label`).toEqual([menuLabel(o.path)]);
  const roots = q(container, '.lims-settings');
  expect(roots.length, `${where}: the page is one kit SettingsForm (.lims-settings)`).toBe(1);
  const root = roots[0]!;
  const forms = q(root, 'form.lims-settings-form');
  expect(forms.length, `${where}: one form.lims-settings-form`).toBe(1);
  const form = forms[0]!;
  expect(form.lastElementChild?.classList.contains('lims-settings-bar'), `${where}: the sticky Save bar is last in the form`).toBe(true);
  const bar = form.querySelector('.lims-settings-bar')!;
  const barSubmits = q(bar, 'button[type="submit"]');
  expect(barSubmits.length, `${where}: exactly one Save submit in the bar`).toBe(1);
  expect(norm(barSubmits[0]!.textContent), `${where}: Save label`).toMatch(/^save/i);
  expect(q(container, 'button[type="submit"]').length, `${where}: no other submit button on the page (no per-card Save)`).toBe(1);
  expect(q(container, '.lims-btn-primary').length, `${where}: one primary button on the page`).toBe(1);
  if (o.noCards !== false) expect(q(root, '.lims-settings-fields .lims-card').length, `${where}: no Card boxes around fields (rule 3: hierarchy by size and grey, not boxes)`).toBe(0);
  expect(norm(container.textContent), `${where}: no exclamation marks`).not.toMatch(/!/);
  expect(norm(container.textContent), `${where}: no development notes`).not.toMatch(/\b(TODO|FIXME|lorem|WIP|not implemented|T0D-|CR-C\d)/i);

  // tabs
  const tabs = tabNames(container);
  if (o.tabs === undefined) expect(q(container, '.lims-settings-tabs').length, `${where}: a one-section screen has no tabs`).toBe(0);
  else {
    expect(q(container, '.lims-settings-tabs').length, `${where}: tabs sit in the SettingsForm tabs slot`).toBe(1);
    if (Array.isArray(o.tabs)) expect(tabs, `${where}: tab names`).toEqual(o.tabs);
    else {
      const t = o.tabs as { include: readonly string[]; min?: number };
      for (const n of t.include) expect(tabs, `${where}: tab "${n}"`).toContain(n);
      expect(tabs.length, `${where}: several tabs`).toBeGreaterThanOrEqual(t.min ?? 2);
    }
  }

  // fields: union over tabs
  const names = new Set(fieldNames(container));
  const labels = new Set(labelTexts(container));
  if (o.tabs !== undefined && o.unionTabs !== false) {
    for (const el of q(container, '.lims-settings-tabs [role="tab"]')) {
      await userEvent.click(screen.getAllByRole('tab', { name: norm(el.textContent) })[0]!);
      fieldNames(container).forEach((n) => names.add(n));
      labelTexts(container).forEach((n) => labels.add(n));
    }
  }
  for (const n of o.names ?? []) expect(names.has(n), `${where}: field "${n}" is still there (found ${JSON.stringify([...names])})`).toBe(true);
  for (const re of o.labels ?? []) expect([...labels].some((l) => re.test(l)), `${where}: a field labelled ${re} is still there`).toBe(true);
}

/** Dirty state (template 4): the Save bar says "Unsaved changes" only after an edit. Types one character into the first text/number input of the fields. */
export async function expectDirtyState(container: HTMLElement, path: string): Promise<void> {
  expect(container.querySelector('.lims-settings-bar'), `${path}: the sticky Save bar exists`).not.toBeNull();
  const bar = () => container.querySelector('.lims-settings-bar')!;
  expect(norm(bar().textContent), `${path}: pristine form shows no dirty note`).not.toMatch(/unsaved changes/i);
  const input = q(container, '.lims-settings-fields input').find((i) => !['checkbox', 'radio', 'hidden', 'password'].includes(i.getAttribute('type') ?? 'text') && !(i as HTMLInputElement).readOnly && !(i as HTMLInputElement).disabled);
  expect(input, `${path}: an editable text/number input exists`).toBeTruthy();
  await userEvent.type(input as HTMLInputElement, '1');
  expect(norm(bar().textContent), `${path}: after an edit the bar shows "Unsaved changes"`).toMatch(/unsaved changes/i);
}

/** One success toast (rule: one success toast): exactly one `.lims-toast` with the text, and no second in-page "saved" banner next to it. */
export function expectOneSavedToast(container: HTMLElement, path: string): void {
  const toasts = q(document.body, '.lims-toast').filter((t) => /saved/i.test(t.textContent ?? ''));
  expect(toasts.length, `${path}: exactly one success toast`).toBe(1);
  const inPage = q(container, '.lims-banner, [role="status"]').filter((b) => !b.closest('.lims-toast-region') && /saved/i.test(b.textContent ?? ''));
  expect(inPage.map((b) => norm(b.textContent)), `${path}: no second "saved" message in the page`).toEqual([]);
  expect(norm(container.querySelector('.lims-settings-bar')?.textContent), `${path}: the dirty note is gone after save`).not.toMatch(/unsaved changes/i);
}
