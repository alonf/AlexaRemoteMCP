## Context

alexa-remote2 exposes `getListsV2`, `getListItemsV2` and `getNotifications`. Their response shapes are not live-verified.

## Decisions

- Defensive summarizers in `lists-reminders.ts` tolerate unknown shapes and return empty results rather than throwing.
- Calls go through the adapter's `read()` wrapper (POST list fetches are still reads).
- Writes are deferred: the upstream write calls lack the proof-of-write patch and need approval gating.
- Alexa "notes" are assumed to map to lists; to be confirmed live.
