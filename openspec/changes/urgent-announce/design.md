## Context

`SpeechService.say` gates through `gateApproval` when the policy is `approve`. The agent cannot be trusted to judge urgency, but the owner can pre-authorise named categories. The approval step is the main security boundary for speech, so skipping it needs compensating limits.

## Decisions

**D1: Owner-defined reasons, exact match.** `SPEAK_URGENT_REASONS` is a site setting; matching is case-insensitive and exact against a short token (`[a-z_]{1,32}`). The agent sees the allowed reasons in the `speak` tool description only as a hint; the server is the only judge.

**D2: Bypass only the approval, nothing else.** Validation, target allowlist, offline check and `SPEAK_POLICY=off` all run first. An unlisted reason is not an error: the call simply goes through the normal path.

**D3: Separate limit, no fallback.** A second in-memory window (default 2 per 10 minutes) counts urgent announcements. Reaching it refuses the call; it never silently downgrades to an approval request, so the agent cannot use the limit to spam approvals either.

**D4: Mandatory notification.** A new event type `speech.urgent` with `{reason}` is published through the existing delivery. A failed delivery never blocks the announcement (it already cannot block, as publish is fire-and-forget), but the journal row also records the reason so the owner can audit after the fact.

**D5: Announce mode.** Urgent calls use the same `mode` argument; the owner's phrasing for emergencies would normally use `announce` for the chime.

## Risks / Trade-offs

- **Self-declared reason**: cannot be verified. Mitigated by the reason list, device allowlist, tight limit, plain-text cap and notification. Accepted by the owner.
- **Reason text drift**: the model may use a near-miss word. Result: normal approval, which is the safe direction.
