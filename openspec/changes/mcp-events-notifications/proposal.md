# Proposal

## Why

The server only answers when asked. A device action that waits for the owner's approval, or an Alexa session that needs re-login, goes unnoticed until the owner next talks to an agent. ChatGPT supports MCP Events: a client subscribes with a webhook, and the server pushes a signed, content-free "doorbell" that wakes the agent. FliessNotificationSystem (`review.requested`) and RingMCPBridge (`ring.event`) already do this in production, with the owner's own measurements (the agent reads 12-31 s after the event). This server should use the same proven channel.

## What Changes

- Serve the MCP Events methods on the MCP endpoint: `events/list`, `events/subscribe`, `events/unsubscribe`, and declare the `events` capability.
- Two event types: `approval.requested` (a device action is waiting for owner approval) and `session.attention` (the Alexa session needs re-login or is failing).
- Deliver each event as a Standard Webhooks signed POST to the subscribed callback, after a signed challenge check at subscribe time. Retry with backoff, end the subscription on 410.
- Callback safety: HTTPS only, host allowlist (default `connectors.api.openai.com`), public addresses only, no redirects, size and time limits.
- Subscriptions are stored sealed (signing secret never in the clear) and expire after at most 24 hours; the client renews.
- Events carry no device names beyond the owner's catalog label, no ids that grant authority and no Alexa text; the agent reads details with a tool.

Non-goals: push to phones or Teams, state-change events (`action.completed`), guaranteed delivery across restarts (the client can always read with a tool), Claude's event support (not verified).

## Capabilities

### New Capabilities
- `mcp-events`: subscription, verification, signing, delivery and expiry of MCP Events webhooks, and the two event types.

### Modified Capabilities

## Impact

- New `src\events\` module (subscriptions store, callback transport, signature, delivery), event handlers in `src\http-server.ts`, a hook in `src\approval-gate.ts` and a session-health hook in `src\server.ts`.
- SQLite journal gains a `subscriptions` table (secret sealed with the existing key material); one new setting `EVENT_CALLBACK_HOSTS`.
- Needs the MCP SDK to pass an `events` capability and custom request handlers; verify with SDK 1.32.2 first (design decision D1).
- Reference: `C:\Dev\RingMCPBridge\bridge\src\core\clients\delivery\*`, `C:\Dev\FliessNotificationSystem\docs\decisions\review-channel-mcp.md`.
