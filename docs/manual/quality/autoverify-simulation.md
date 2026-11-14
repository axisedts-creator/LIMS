# Auto-verification simulation — user manual

**Screen:** `/quality/autoverify/{version_id}`

This page is part of the quality user manual. The same steps appear in the in-app help (press F1 or the ? icon).

## Purpose

Run a draft rule set in the background without effect, and see what it would have decided on real results. The simulation report tells you whether the rules are safe to switch on.

## Steps

1. Open Auto-verification and open a draft version.
2. Press Start simulation. The version decides in shadow mode only.
3. After the minimum days and decisions are reached, open the report: would allow, would deny, deny by reason, and a sample of would-allow results.
4. Compare with manual verification. Fix the rules and start a new version if the numbers are wrong.

## Shortcuts

- Tab and Shift+Tab move between fields
- Esc closes a dialog

## Error messages

- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.

## Tips

- A simulation never verifies a result.
