# Queue

This page explains the queue screens. It mirrors the in-app help for `engagement.queue` and `engagement.queue_setup`.

## Queue console (`/engagement/queue`)

Help key `engagement.queue`. Choose your counter, then call the next token. The waiting list refreshes every few seconds. Staff need the permission `engagement.queue.operate`.

| Key | Action |
|---|---|
| `Alt+N` | Call next |
| `Alt+R` | Recall |
| `Alt+S` | Serving |
| `Alt+D` | Done |
| `Alt+K` | Skip |
| `Alt+T` | Transfer to another queue |
| `Alt+I` | Issue a token for a walk-in |

With nobody waiting, Call next shows "No one is waiting." The printed slip carries only the lab name, queue name, token and time.

## Queue setup (`/engagement/queue/setup`)

Help key `engagement.queue_setup`. Needs `engagement.queue.manage`. Three tabs:

1. Queues: code, name, token letter prefix, order, Active.
2. Counters: name, order, Active.
3. Displays: name, which queues it shows, status and last seen.

Switch off a queue or counter you no longer use instead of deleting it.

## Pairing a display screen

Open queue setup in the TV's own browser, press Pair this screen, then sign out. The screen keeps showing the queue without a staff sign-in. Revoke the display if the TV is lost or moved. The display page itself is `/queue-display`; it shows token numbers only and no patient names.
