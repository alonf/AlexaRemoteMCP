# Proposal

## Why

An agent that started a mutation (possibly after a held approval) has no signal when it finishes. A doorbell event lets it wake and report the result.

## What Changes

- Add an `action.completed` event type published after a mutation finishes (any final status), with a short summary (`<phrase> "<label>"`) and the status.
- Not published for policy-rejected calls. A failing publish never affects the mutation result.

## Capabilities

### New Capabilities
- `action-completed`: completion doorbell event.

### Modified Capabilities

None.

## Impact

- `src\mutation-service.ts` (`onCompleted` hook), `src\events\delivery.ts` (event type), `src\service.ts` (wiring).
