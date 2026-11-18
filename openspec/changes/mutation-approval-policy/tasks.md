# Tasks

## 1. Feasibility

- [x] 1.1 Check what `@modelcontextprotocol/sdk` 1.32.2 supports for MRTR (`InputRequiredResult`, `inputResponses`, `requestState`, client capability access) and record the chosen approach, upgrading the SDK only if it supports the 2026-07-28 revision
- [x] 1.2 Read the owner's real shutter and heater capabilities from the inventory (private, not committed) and record which capability opens or closes a shutter

## 2. Action policy modes

- [x] 2.1 Add the category classifier (`light`, `cover`, `climate`, `access`, `query`, `other`) with unknown mapped to `other`
- [x] 2.2 Add the strict `ACTION_POLICY` parser with presets and startup failure on unknown tokens
- [x] 2.3 Replace the hard-coded safety refusal in `src\mutation-policy.ts` with the mode lookup, keep the allow-list as a narrowing filter, support `*`, and keep the Milestone B default when `ACTION_POLICY` is unset
- [x] 2.4 Unit tests: every category and mode pair, deny default, invalid settings, allow-list narrowing and wildcard, backward-compatible default

## 3. Owner approval through MRTR

- [x] 3.1 Add signed request state (HMAC, subject, device, action, value, expiry, nonce) with the key held in Key Vault and single-use nonce recording in the journal
- [x] 3.2 Build the server-generated elicitation message from the resolved device name, action and value
- [x] 3.3 Return the input-required result for `approve` mode, and on retry verify the accepted response and state before dispatching once
- [x] 3.4 Refuse with `approval_unsupported` when the client did not declare elicitation or the protocol version is older than 2026-07-28
- [x] 3.5 Journal approval requests and decisions without storing the signed state
- [x] 3.6 Unit tests: accept, decline, cancel, tampered, expired, reused, different subject, model-supplied `confirmed`, unsupported client, uncertain write needs new approval

## 4. Tool surface

- [x] 4.1 Add `set_device_state` with `on`, `off`, `open`, `close`, `set_brightness`, validated against declared capabilities, and keep the existing `light_*` tools (there is no `set_light`)
- [x] 4.2 Add an end-to-end test through the HTTP server with a fake adapter covering allow, approve and deny paths

## 5. Documentation and deployment

- [x] 5.1 Document `ACTION_POLICY`, the presets, the allow-list interaction and the access-class warning in `docs\cloud-deployment.md`, and update the security review
- [x] 5.2 Document the `approval-key` Key Vault secret, which the app creates itself like `issuer-keys` (no Bicep change)
- [x] 5.3 Run lint, the full test suite and the secret scan

## 6. Owner-approved live checks

- [ ] 6.1 With owner approval, verify an `approve` call from ChatGPT and from Claude, and record sanitized notes on whether each client supports the MRTR retry
- [ ] 6.2 With owner approval, open and close one shutter through an approved call, and leave it in its original position
- [ ] 6.3 Record the sanitized evidence in `docs\live-evidence-milestone-b.md` or a successor file
