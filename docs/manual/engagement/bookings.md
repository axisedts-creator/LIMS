# Bookings and slots

This page explains the booking screens. It mirrors the in-app help for `engagement.bookings`, `engagement.booking_detail`, `engagement.booking_new`, `engagement.slots` and `engagement.bookable`.

## Bookings list (`/engagement/bookings`)

Help key `engagement.bookings`. The list shows visits and home collections. By default it shows today, your working centre, and the statuses Confirmed and Checked in. You can widen the date range up to 31 days. Each row shows time, booking number, patient, type, number of tests, source (App or Staff), status and the linked order.

Keys: `Alt+B` new booking, `Alt+C` check in the selected row, `Alt+X` cancel the selected row. You need the permission `engagement.booking.read` to open the list.

## Booking detail (`/engagement/bookings/{booking_id}`)

Help key `engagement.booking_detail`. Shows patient, type, centre or address, slot, tests with indicative price, status and the timeline of changes. Check in can also issue a queue token. Cancel asks for a reason from the lab list.

## New booking

Help key `engagement.booking_new`. Search the patient (three letters or more), choose centre visit or home collection, pick the date and an open slot, add up to 20 tests, then press `Ctrl+Enter`. Prices are indicative; the bill is made at registration.

## Slot templates and blackouts (`/engagement/slots`)

Help key `engagement.slots`. A template sets weekdays, hours, slot length and capacity for a centre. If a new template leaves future slots over capacity, a warning gives the count. A blackout closes a period; bookings inside it are not cancelled automatically, so review them in the bookings list. Needs `engagement.slot.manage`.

## Bookable catalogue (`/engagement/bookable-items`)

Help key `engagement.bookable`. Lists the tests and packages patients can book. Add from the lab catalogue, choose centre visit or home collection, and switch Active on or off. Use Refresh from catalogue after catalogue changes. Needs `engagement.bookable_item.manage`.
