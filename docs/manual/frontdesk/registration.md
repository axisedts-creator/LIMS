# Registration (screen `/frontdesk/registrations/new`)

This page explains how to register a patient visit. It mirrors the in-app help for New registration.

## Steps

1. Check the **Centre**, then find the patient (`F2`) or open the new patient form (`Alt+N`).
2. Set the visit type (`Alt+O` OPD, `Alt+I` IPD), billing mode (`Alt+C` cash or credit) and referrer (`F3`).
3. Add tests with `F4`. Mark a test urgent with `U`, or the whole order with `Alt+R`. Remove a test with `Del`.
4. Check the bill. For a discount press `F6`; if it needs approval press `Alt+A` and an approver decides at `/frontdesk/discount-approvals`.
5. Enter the payment (`F8`, add a method row with `Alt+P`). Attach the request form with `Alt+U` if you have one.
6. Press `Ctrl+Enter` to register and print. If nothing was paid you are asked to confirm first.

## After registering

- `Alt+G` opens the order at `/frontdesk/orders/<id>`.
- `Alt+L` retries a label print that failed.
- `Ctrl+Shift+N` starts the next registration.

## Downtime back-entry

For paper forms written while the system was down, switch on Downtime back-entry and enter the original time and the paper form serial.

## Shortcut list

Press `?` on the screen. Full list: `F2` patient, `Alt+N` new patient, `F3` referrer, `Alt+D` quick-add doctor, `F4` tests, `Del` remove, `U` urgent item, `Alt+R` urgent order, `Alt+O` OPD, `Alt+I` IPD, `Alt+C` cash/credit, `F6` discount, `Alt+A` approval request, `F8` payment amount, `Alt+P` payment row, `Alt+U` TRF upload, `Ctrl+Enter` register and print, `Ctrl+Shift+N` new registration, `Alt+L` retry label, `Alt+G` open order, `Esc` close, `?` help.
