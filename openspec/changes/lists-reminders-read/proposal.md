# Proposal

## Why

The owner wants an agent to read Alexa lists, notes and reminders. Reads carry no side effects, so they can ship before writes.

## What Changes

- Add read-only tools `list_lists`, `get_list_items` and `list_reminders`, enabled only when `LISTS_REMINDERS_READ=on` (default off) and the read scope is permitted.
- Responses are reduced to safe fields (ids, names, text, status, time); customer and device identifiers are dropped.
- Not in scope: writes, routines.

## Capabilities

### New Capabilities
- `lists-reminders-read`: reading lists, list items and reminders.

### Modified Capabilities

None.

## Impact

- `src\lists-reminders.ts`, `src\alexa-adapter.ts`, `src\ports.ts`, `src\server.ts`, `src\http-server.ts`, `src\service.ts`, `docs\cloud-deployment.md`.
