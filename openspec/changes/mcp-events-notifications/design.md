## Context

ChatGPT is the client that cannot elicit approvals and is slow to notice anything between turns. Two sibling projects solved wake-up with MCP Events and measured it with the real client: FNS `review.requested` and RingMCPBridge `ring.event` (agent reads 12-31 s after the event; event works as a doorbell, the tool returns the details). This design copies their delivery model and leaves their extras out.

## Goals / Non-Goals

**Goals:** wake a subscribed agent when an approval is waiting or the Alexa session needs attention; no secrets or authority in the event; safe outbound calls.

**Non-Goals:** durable delivery across restarts, action-completed events, other transports (SSE, polling), push to phones.

## Decisions

- **D1: events capability on SDK 1.32.2.** Ring registers `{ events: {} }` as a capability and sets request handlers for `events/*` on the low-level server (`server.server.setRequestHandler`). Task 1.1 proves this works on our SDK with a stateless per-request server before any other work. Fallback if the SDK refuses unknown methods: intercept `events/*` JSON-RPC in `http-server.ts` before the SDK transport. Unresolved until 1.1.
- **D2: doorbell, not content.** The event names the type, id, time, the catalog label and operation phrase (approval) or the health state (session). The agent calls `find_device` or a status tool for the rest. This keeps approval ids and Alexa text out of a third party's logs, and stops injected text from steering the agent.
- **D3: `approval.requested` fires where the gate issues a held approval** (the MRTR input-required path and the chat-confirmation `confirmation_required` path in `approval-gate.ts`), not when it is answered. Duplicate sends for one `approvalId` are suppressed.
- **D4: `session.attention` fires on health transitions** in the session manager (usable to a failing state), once per transition, so a down session does not spam.
- **D5: transport copied from Ring's `callback-transport.ts`:** own HTTPS agent, resolver-time address check against a non-public block list, no redirects, timeout, response size cap. Allowlist is `EVENT_CALLBACK_HOSTS`, default `connectors.api.openai.com`.
- **D6: signing is Standard Webhooks** (`id.timestamp.body`, HMAC-SHA256, `v1,` base64), because ChatGPT accepted exactly that in Ring's proof.
- **D7: storage.** A `subscriptions` table in the existing SQLite journal file on `/home`. The `whsec_` key must be recoverable to sign, so it is AES-256-GCM encrypted with a key derived (HKDF, own label) from the existing approval signing secret in Key Vault. A leak of the SQLite file alone reveals no key. Retention: rows past expiry are deleted on read.
- **D8: at-least-once while the process runs.** Retries after 1, 2, 4, 8 s with the same event id; 410 ends the subscription; no persistence of in-flight sends. A restart can drop an event: the agent also reads current state with a tool, and `list_pending_approvals` is not needed because approvals expire in 2 minutes.
- **D9: scope.** Subscribing needs the read scope (as Ring). The event discloses a device label and an operation phrase to a client that can already read the inventory.

## Risks / Trade-offs

- **SSRF/redirect abuse** if the transport is wrong. Mitigated by D5 and tests for private resolution and redirects.
- **Subscriber receives an approval request it cannot answer** (ChatGPT may only be woken). It is still useful: it can tell the owner, and the owner can ask it to retry, which issues the chat confirmation. Whether an agent acts on its own is the owner's call; the event text says "ask the owner".
- **ChatGPT may not renew the subscription** (Ring saw one unexplained renewal). Mitigation: 24 h cap, health note in the docs; no server-side fix.
- **Restarts and deploys drop subscriptions' in-flight events** (D8) but not the subscriptions themselves (D7).
- **Event timing is unmeasured** for our server. Task 4.2 measures it live.

## Open questions

- Does Claude support MCP Events at all? Not assumed; verified during 7.4 of the Milestone B change.
- A `status` read tool for pending approvals and session health may be wanted so the doorbell has something to read. Decide after 1.1.
