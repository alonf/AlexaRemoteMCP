## Context

The approval gate already signs a state binding subject, target and a digest of operation and parameters, and journals it as single-use. ChatGPT cannot elicit, so the gate refused.

## Decisions

- **Reuse the signed state as `approvalId`.** The same signer and `approvals` journal table give binding, expiry and single use for free. The signed payload gained an issue time (`iat`) for the delay check.
- **Global, not per device.** An earlier build had a per-device opt-in; the owner chose a single switch because the fallback is temporary and per-device setup adds friction. Blocked, disabled, unsupported and read-only devices are unaffected.
- **Typed or spoken.** The server only sees `approvalId` and `confirmed`, so both work.
- **3-second minimum.** A cheap guard against a model confirming in the same turn as the ask. Refusal does not consume the id.
- **Catalog edits excluded.** They change policy, so they keep requiring a real prompt.
- **Off switch.** `CHAT_CONFIRMATION=off`, read per call.

## Risks

The server cannot prove a human answered. The question text comes from the server and every ask and decision is journaled. If this is unacceptable for a device, set it to `deny` or disable the fallback.
