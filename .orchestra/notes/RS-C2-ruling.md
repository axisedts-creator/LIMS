TESTS_WRONG — t20.roles-org.test.tsx assumes exactly one Save button in the master drawer; the spec now requires one Save per section.
- spec/program/10-DESIGN-SYSTEM.md:106 (s4 Masters): "drawer form on the right with sections and per-section Save. Never a 40-field page". The RS-C2 task acs cite s4, and LD-140 (inbox task brief line 31) makes 10-DESIGN-SYSTEM binding for RS-C2.
- spec/program/10-DESIGN-SYSTEM.md:135 (s7.2): RS tasks change "appearance and arrangement only; no API, field, validation, permission or route change". So t20's behaviour assertions (PATCH changed fields only, If-Match, POST body, no tenant_id, bad code sends no request, inline 409 error) are still required and must not change.
- No C2 chunk doc requires a single Save button (grep of spec/chunks/C2-identity-admin for "one Save|single Save|Save button": no matches). The single-button query is a layout detail inside the test, not a spec rule.
Change to make in apps/web/src/features/admin/__tests__/t20.roles-org.test.tsx, lines 240, 257, 261 and 279 only:
- Replace `within(dlg).getByRole('button', { name: /^save/i })` (and the `/^(save|create)/i` form) with a query scoped to the section that holds Name, e.g.
  `within(within(dlg).getByLabelText(/^name/i).closest('section')!).getByRole('button', { name: /^(save|create)/i })`.
- Do not use `getAllByRole(...)[0]`: it depends on the order of sections. Leave every other line and assertion as it is.
Not part of this ruling: the `t12.actions.test.ts` failure ("Cannot find module '../nav/generated'") is outside RS-C2. Report it separately; do not fix it in this lane.
