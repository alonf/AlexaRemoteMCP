## Context

The doorbell already carries `approval.requested` and `session.attention`.

## Decisions

- `MutationService.onCompleted(summary, status)` is invoked after `journal.end` inside try/catch; `service.ts` maps it to a published event. This keeps the mutation service free of event dependencies.
- The summary reuses the existing phrase and label only; no device identifiers beyond the catalog label.
