## Why

Approval-mode actions need an MRTR elicitation. ChatGPT negotiates protocol 2025-11-25 and declares no elicitation, so every approval-mode action (boiler, shutters) is refused with `approval_unsupported`. The owner wants to approve in the conversation itself, by typing or by voice, until ChatGPT supports MRTR.

## What Changes

- When the client cannot elicit, an approval-mode device action returns `confirmation_required` with a server-written question and a signed `approvalId`, and dispatches nothing.
- The mutation tools accept optional `approvalId` and `confirmed`. The assistant asks the user and repeats the call only after the user answers.
- The id is signed, single-use, bound to principal, device and action, and expires in 2 minutes. A confirmation under 3 seconds after the ask is refused without consuming the id.
- It applies to every approval-mode device action, with no per-device flag. `CHAT_CONFIRMATION=off` disables it.
- Catalog edits are not eligible and still need a real approval prompt.
- A client that can elicit keeps using MRTR, so the fallback needs no removal once ChatGPT supports it.

## Capabilities

### New Capabilities
- `chat-confirmation`: model-relayed confirmation for clients that cannot elicit.

### Modified Capabilities
None.

## Impact

`approval-gate.ts`, `approval.ts` (issue time in the signed state), `mutation-service.ts`, `http-server.ts` (tool arguments), tests, `docs/cloud-deployment.md`.

Known weakness: the server cannot verify that a human gave the answer; a model could confirm on its own. The mitigations above reduce but do not remove this, which is why catalog edits and the default-off switch exist.
