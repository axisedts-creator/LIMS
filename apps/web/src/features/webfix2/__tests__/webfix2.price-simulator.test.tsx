// @vitest-environment jsdom
// T0D-WEBFIX-2 (4): the price simulator's "At" field hint must say what the field does and when to leave it empty
// (walkthrough 2026-11-17: "Leave empty for now." told the user nothing). Not asserted: exact wording; only the content.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PriceSimulator } from '@/features/catalog/components/PriceSimulator';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog/price-simulator',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/features/catalog/server/catalogActions', () => ({ searchDoctorsAction: vi.fn(), searchOrderablesAction: vi.fn(async () => []) }));
vi.mock('@/features/catalog/server/pricingActions', () => ({
  quotePricesAction: vi.fn(), searchCentresAction: vi.fn(async () => []), searchCreditPartiesAction: vi.fn(async () => []), searchPriceListsAction: vi.fn(async () => []),
}));
const g = globalThis as any;
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
g.matchMedia ??= (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
afterEach(cleanup);

describe('price simulator "At" hint (T0D-WEBFIX-2 item 4)', () => {
  it('the hint explains the field and says when to leave it empty', () => {
    const { container } = render(<PriceSimulator permissions={['catalog.price_list.read']} />);
    expect(screen.getAllByText(/^At$/).length).toBeGreaterThan(0); // the field is still there
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Leave empty for now\.?/);
    // what it does: prices valid at that date and time
    expect(text, 'says what the field does').toMatch(/(price|prices|quote)[^.]*\b(on|at|as of|valid|effective)\b[^.]*\b(date|time|moment)|\b(date|time)\b[^.]*\bprice/i);
    // when to leave it empty: for the current / today's price
    expect(text, 'says when to leave it empty').toMatch(/leave (it )?empty[^.]*\b(current|now|today|latest)\b|\b(current|now|today|latest)\b[^.]*leave (it )?empty|empty[^.]*(current|now|today|latest)/i);
  });
});
