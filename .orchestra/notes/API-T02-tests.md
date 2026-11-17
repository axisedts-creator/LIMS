# API-T02 tests
- Files (vitest) in `services/api/src/modules/instruments/__tests__/unit/`: `state-machines.test.ts` (agent, instrument, credential, command: all allowed + ALL forbidden pairs, AC-04.5), `health.test.ts` (AC-13.2–13.5), `keys-decimal.test.ts`, `instrument-time.test.ts`, `transport-schemas.test.ts`.
- Run: `.orchestra\notes\API-T02-verify.cmd` (needs `pnpm install`; no `node_modules` here, so not run).
- Each file's header comment fixes the expected API of `domain/*` (agent.state, instrument.state, credential.state, **command.state.ts (new file, plan names a command machine)**, health, keys, decimal, instrumentTime, transportSchemas). Forbidden moves throw Error with `.code = 'instruments.invalid_transition'`.
- Assumptions beyond spec text: unknown properties rejected in transport/file_drop/protocol_options; health active-hours use tenant timezone; device_token cannot be redeemed/expired.
- Not covered: DST gap/overlap in `localToUtc` (spec silent), overnight silence windows (from > to), `delivered`→`delivered` command re-send, astm protocol_options (§5.2.4 not read), driver/checklist guards (service layer, API-T05).
