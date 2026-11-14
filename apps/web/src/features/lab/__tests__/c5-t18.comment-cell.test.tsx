// @vitest-environment jsdom
// C5.T-18 — short-code expansion in the result grid comment cell (04-UI-UX §3.6 "Short codes"; PRD AC-10.1; AC-10.3 as seen from the UI; 07-SECURITY S-14).
// The server side (re-resolution, stored code + version + text, 400 for unknown) is tested in services/api/.../result.service.shortcodes.test.ts.
//
// ASSUMED module/prop contract (spec fixes behaviour + folder `components/grid/`; the writer may dispute a name via the ruling flow):
//   apps/web/src/features/lab/components/grid/CommentCell.tsx   export function CommentCell(props)  (named export; 'use client' component)
//     props: {
//       label?: string                      accessible name of the text box (default "Comment")
//       defaultValue?: string               initial comment text
//       defaultCodes?: readonly string[]    initial recorded codes
//       lookupCode(prefix: string): Promise<readonly { code: string; text: string; version: number }[]>
//                                           = C3 GET /v1/catalog/comment-codes?code_prefix=<prefix> via the BFF (listCommentCodes #57); the production wiring is the grid screen task (T-20)
//       onChange?(next: { text: string; codes: string[] }): void     called after every change of the text or of the recorded codes (`codes` = the comment_codes sent on save)
//     }
//   Behaviour (04-UI-UX §3.6): a token = ':' + 1..16 of [A-Z0-9_], at the start of the text or after whitespace, followed by Space or Tab typed right behind it.
//     * hit  = the list contains an entry whose `code` EQUALS the token code (a longer code found by prefix is not a hit): the token (and its trigger key) is replaced by the library text;
//              the code is recorded once in `codes` (no duplicates); text typed before/after the token is kept.
//     * miss = token stays as typed, inline hint "Unknown code {CODE}" (text, not colour only), the code is NOT recorded, no throw.
//     * lookup rejects (network / 5xx) -> token stays, no "Unknown code" hint (it is not known to be unknown), no crash.
//     * anything that is not a token (lower-case, 17+ chars, colon inside a word such as a time 10:30) never calls lookupCode.
//     * Ctrl+Space opens the code picker (role listbox, options show the code + text; typing searches by prefix and calls lookupCode(prefix)); choosing an option inserts the text and records the code.
//     * Library text is plain text: markup in it is inserted as characters (S-14), never interpreted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CommentCell } from '../components/grid/CommentCell';

afterEach(() => cleanup());

const LIBRARY = [
  { code: 'HYPO', text: 'Hypochromia present.', version: 3 },
  { code: 'HYPOX', text: 'Hypoxia pattern.', version: 1 },
  { code: 'MICRO', text: 'Microcytosis noted.', version: 2 },
  { code: 'XSS', text: '<img src=x onerror=alert(1)>', version: 1 },
];
// behaves like C3 list #57: prefix match, so HYPO also returns HYPOX
const lib = () => vi.fn(async (prefix: string) => LIBRARY.filter((c) => c.code.startsWith(prefix.toUpperCase())));

function setup(props: Partial<Parameters<typeof CommentCell>[0]> = {}) {
  const lookupCode = lib();
  const onChange = vi.fn();
  const user = userEvent.setup();
  const utils = render(<CommentCell lookupCode={lookupCode} onChange={onChange} {...props} />);
  const box = screen.getByRole('textbox', { name: /comment/i }) as HTMLInputElement | HTMLTextAreaElement;
  const last = () => onChange.mock.calls.at(-1)?.[0] as { text: string; codes: string[] };
  return { lookupCode, onChange, user, box, last, ...utils };
}

describe('T-18 AC-10.1 ":CODE<space>" expands to the library text', () => {
  it('typing ":HYPO " replaces the token with the library text and records the code', async () => {
    const { user, box, lookupCode, last } = setup();
    await user.click(box);
    await user.keyboard(':HYPO ');
    await waitFor(() => expect(box.value).toMatch(/^Hypochromia present\.\s?$/));
    expect(lookupCode).toHaveBeenCalledWith('HYPO');
    expect(last().codes).toEqual(['HYPO']);
    expect(last().text.trim()).toBe('Hypochromia present.');
    expect(screen.queryByText(/unknown code/i)).toBeNull();
  });
  it('Tab also triggers the expansion', async () => {
    const { user, box, last } = setup();
    await user.click(box);
    await user.keyboard(':MICRO{Tab}');
    await waitFor(() => expect(box.value).toMatch(/^Microcytosis noted\.\s?$/));
    expect(last().codes).toEqual(['MICRO']);
  });
  it('text typed before and after the token is kept (token in the middle of a sentence)', async () => {
    const { user, box, last } = setup();
    await user.click(box);
    await user.keyboard('Smear: :HYPO ');
    await waitFor(() => expect(box.value).toContain('Hypochromia present.'));
    await user.keyboard('Repeat advised.');
    expect(box.value).toMatch(/^Smear: Hypochromia present\.\s?Repeat advised\.$/);
    expect(last().codes).toEqual(['HYPO']);
  });
  it('the exact code is used, not the first prefix match: ":HYPO " must not become the text of HYPOX', async () => {
    const { user, box } = setup();
    await user.click(box);
    await user.keyboard(':HYPO ');
    await waitFor(() => expect(box.value).toContain('Hypochromia'));
    expect(box.value).not.toContain('Hypoxia');
  });
  it('a code whose only list match is a LONGER code (":HYP ") is a miss', async () => {
    const { user, box, last } = setup();
    await user.click(box);
    await user.keyboard(':HYP ');
    expect(await screen.findByText(/unknown code HYP/i)).toBeTruthy();
    expect(box.value).toContain(':HYP');
    expect(last()?.codes ?? []).toEqual([]);
  });
  it('two different codes are both recorded; the same code twice is recorded once', async () => {
    const { user, box, last } = setup();
    await user.click(box);
    await user.keyboard(':HYPO ');
    await waitFor(() => expect(box.value).toContain('Hypochromia'));
    await user.keyboard(':MICRO ');
    await waitFor(() => expect(box.value).toContain('Microcytosis'));
    await user.keyboard(':HYPO ');
    await waitFor(() => expect(box.value.match(/Hypochromia present\./g)?.length).toBe(2));
    expect(last().codes).toEqual(['HYPO', 'MICRO']);
  });
  it('codes already recorded (defaultCodes) are kept in onChange when more text is typed', async () => {
    const { user, box, last } = setup({ defaultValue: 'Hypochromia present.', defaultCodes: ['HYPO'] });
    await user.click(box);
    await user.keyboard(' ok');
    expect(last().codes).toEqual(['HYPO']);
    expect(last().text).toBe('Hypochromia present. ok');
  });
});

describe('T-18 AC-10.3 unknown code stays visible with an inline hint', () => {
  it('":NOPE " stays as typed, shows "Unknown code NOPE" as text, and is not recorded', async () => {
    const { user, box, last } = setup();
    await user.click(box);
    await user.keyboard(':NOPE ');
    expect(await screen.findByText(/unknown code NOPE/i)).toBeTruthy();
    expect(box.value).toContain(':NOPE');
    expect(last()?.codes ?? []).toEqual([]);
  });
  it('the hint goes away once the token is edited away', async () => {
    const { user, box } = setup();
    await user.click(box);
    await user.keyboard(':NOPE ');
    await screen.findByText(/unknown code NOPE/i);
    await user.clear(box);
    await waitFor(() => expect(screen.queryByText(/unknown code/i)).toBeNull());
  });
  it('a lookup failure (network / 5xx) keeps the token, claims nothing about the code, does not crash', async () => {
    const lookupCode = vi.fn(async () => { throw new Error('bff down'); });
    const { user, box } = setup({ lookupCode });
    await user.click(box);
    await user.keyboard(':HYPO ');
    await waitFor(() => expect(lookupCode).toHaveBeenCalled());
    expect(box.value).toContain(':HYPO');
    expect(screen.queryByText(/unknown code/i)).toBeNull();
  });
});

describe('T-18 what is NOT a token never calls the library', () => {
  it.each([
    ['lower-case ":hypo "', ':hypo '],
    ['colon inside a word / time "10:30 "', '10:30 '],
    ['17 characters', ':' + 'A'.repeat(17) + ' '],
    ['a bare colon ": "', ': '],
    ['token without the trigger key ":HYPO"', ':HYPO'],
  ])('%s', async (_n, typed) => {
    const { user, box, lookupCode } = setup();
    await user.click(box);
    await user.keyboard(typed);
    expect(lookupCode).not.toHaveBeenCalled();
    expect(box.value).toBe(typed);
  });
  it('a 16-character code is a token (upper bound)', async () => {
    const code = 'A'.repeat(16);
    const lookupCode = vi.fn(async () => [{ code, text: 'Sixteen.', version: 1 }]);
    const { user, box } = setup({ lookupCode });
    await user.click(box);
    await user.keyboard(`:${code} `);
    await waitFor(() => expect(box.value).toMatch(/^Sixteen\./));
  });
});

describe('T-18 Ctrl+Space code picker', () => {
  it('Ctrl+Space opens a listbox of codes; picking one inserts its text and records the code', async () => {
    const { user, box, last, lookupCode } = setup();
    await user.click(box);
    await user.keyboard('{Control>} {/Control}');
    await screen.findByRole('listbox');
    expect(lookupCode).toHaveBeenCalled();
    const opt = await screen.findByRole('option', { name: /MICRO/ });
    expect(opt.textContent).toContain('Microcytosis noted.');
    await user.click(opt);
    await waitFor(() => expect(box.value).toContain('Microcytosis noted.'));
    expect(last().codes).toEqual(['MICRO']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('typing in the picker searches by prefix (lookupCode(prefix)); Escape closes it without inserting anything', async () => {
    const { user, box, lookupCode, last } = setup();
    await user.click(box);
    await user.keyboard('{Control>} {/Control}');
    await screen.findByRole('listbox');
    await user.keyboard('HYP');
    await waitFor(() => expect(lookupCode).toHaveBeenCalledWith('HYP'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(box.value).toBe('');
    expect(last()?.codes ?? []).toEqual([]);
  });
});

describe('T-18 S-14 plain text only + accessibility', () => {
  it('library text with markup is inserted as characters; no element is created from it', async () => {
    const { user, box, container } = setup();
    await user.click(box);
    await user.keyboard(':XSS ');
    await waitFor(() => expect(box.value).toContain('<img src=x onerror=alert(1)>'));
    expect(container.querySelector('img')).toBeNull();
  });
  it('axe: the cell (with and without the unknown-code hint) has no violations; the hint is text, not colour only', async () => {
    const { user, box, container } = setup();
    expect((await axe.run(container)).violations).toEqual([]);
    await user.click(box);
    await user.keyboard(':NOPE ');
    await screen.findByText(/unknown code NOPE/i);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
