# Proposal

## Why

The events doorbell (`approval.requested`, `session.attention`) wakes the agent but carries only a short summary. A woken agent has nothing to read to learn what is waiting or whether the Alexa session is healthy, so it cannot give the owner an accurate picture.

## What Changes

- Add a read-only `get_status` tool (read scope) returning the Alexa session health and the caller's pending approvals: operation kind, seconds since requested and seconds until expiry. No approval ids, nonces, request state or device identifiers are returned, so the tool cannot be used to approve anything.
- Add a journal query for approvals still `requested` and inside the 2 minute lifetime, for the calling principal only.
- Not in scope: approving or declining through this tool, history of past approvals, journal browsing.

## Capabilities

### New Capabilities
- `status-read`: reading session health and the caller's pending approvals.

### Modified Capabilities

None.

## Impact

- `src\sqlite-journal.ts` (query), `src\http-server.ts` (tool, option), `src\service.ts` (wiring). Hidden when reads are denied by `ACTION_POLICY`.
