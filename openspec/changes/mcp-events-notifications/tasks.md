## 1. Foundations

- [x] 1.1 Prove the `events` capability and `events/*` handlers work on SDK 1.32.2 in the stateless per-request server; if not, intercept before the SDK (D1). Record the outcome in the design
- [x] 1.2 Add `src\events\webhook-signature.ts` (Standard Webhooks signing, `whsec_` parsing) with tests against a known vector
- [x] 1.3 Add `src\events\callback-transport.ts` (allowlist, resolver-time public-address check, no redirects, timeout, size cap) with tests for private resolution, redirects, oversize and timeout
- [x] 1.4 Add `EVENT_CALLBACK_HOSTS` to config with the ChatGPT default; document it

## 2. Subscriptions and delivery

- [x] 2.1 Add the `subscriptions` table and a store that seals the signing key (AES-256-GCM, HKDF-derived key), with ownership check on remove and expiry cleanup
- [x] 2.2 Add `Delivery`: subscribe with signed challenge, 24 h cap, parallel per-subscriber sends, retries 1/2/4/8 s, 410 ends, 413 not retried
- [x] 2.3 Serve `events/list`, `events/subscribe`, `events/unsubscribe` on the MCP endpoint (read scope; -32015 on a failed challenge)
- [x] 2.4 Value-free logging: event type, client hash, host, status

## 3. Event sources

- [x] 3.1 Emit `approval.requested` from the approval gate (MRTR and chat-confirmation paths), once per approval id
- [x] 3.2 Emit `session.attention` on session health transitions, once per transition
- [x] 3.3 Tests: event payload has no approval id, token or Alexa text; repeats suppressed

## 4. Verification

- [x] 4.1 Lint, full tests and the secret scan
- [ ] 4.2 Owner-approved live check: ChatGPT subscribes; a held approval wakes it; record sanitized timings from the log
- [x] 4.3 Docs: `docs\cloud-deployment.md` (setting, events, privacy) and the security review
