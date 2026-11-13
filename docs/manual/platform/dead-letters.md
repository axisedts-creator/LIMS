# Dead letters

## Purpose

A dead letter is a background task that failed every retry and now waits for a person to decide: replay it or discard it. Address: `/platform/dead-letters`. Permission: `platform.dead_letter.manage`.

## Filters

- **State**: default Open.
- **Platform tasks only**: off by default. When on, only tasks that belong to no tenant are shown, and the Tenant filter is cleared and disabled.
- **Tenant**, **Task**, **Dead at** date range.

## Columns

Dead at, Tenant, Task, Attempts, Last error code, State.

## Steps

### Work through open dead letters

1. Keep State at Open and sort by Dead at.
2. Look for groups of the same task and error code; they usually have one cause.
3. Select a row to open the [dead letter](dead-letter-detail.md) and replay or discard it.

Fix the cause first (for example a provider outage) before replaying, or the task will fail again.
