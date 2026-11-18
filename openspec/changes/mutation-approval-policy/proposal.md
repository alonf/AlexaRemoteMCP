# Proposal

## Why

Milestone B refuses every safety-relevant class (shutters, heaters, locks and so on) outright and permits only allow-listed lights. The owner wants an AI agent to be able to open a shutter or switch a heater, but only after the owner approves that exact action. The owner also wants a simple way to say, per kind of action, whether it is allowed without asking, allowed after approval, or not allowed at all. Today the only control is a list of device IDs, and no approval step exists.

## What Changes

- Add an action policy with three modes per category: `allow` (no consent), `approve` (owner approval for every call), `deny`. Categories: `query`, `light`, `cover`, `climate`, `access`, `other`.
- Configure it with one app setting, `ACTION_POLICY`, using `category=mode` pairs, plus a few named presets (for example `lights-only`, `lights-allow-rest-approve`). Unlisted categories are `deny`. Reads and mutations use the same vocabulary.
- Replace the hard-coded safety refusal with this policy. The device ID allow-list stays as an optional narrowing filter, and `*` now means all devices in an allowed category.
- Add owner approval using the Multi Round-Trip Requests (MRTR) pattern from the MCP 2026-07-28 specification (SEP-2322). A call in `approve` mode returns an incomplete result carrying an elicitation input request and signed request state. The client asks the owner and retries; the server dispatches only on a valid, matching owner acceptance.
- Generalise the single light tool into a device-action tool that covers power for every category, and cover open/close where the device declares the capability.
- Keep the current behaviour when `ACTION_POLICY` is unset and `MUTATION_ALLOWED_TARGETS` is set.

Non-goals: approval for reads that change nothing, scheduled or temporary actions, routines, an approval web page (recorded as a fallback decision in the design), and any live action without owner approval.

Requirement references: SEC-05, SEC-07, CAP-02, CAP-03, CAP-04 in `REQUIREMENTS.md`. This builds on `milestone-b-secure-vertical-slice`, which should be merged first.

## Capabilities

### New Capabilities
- `action-policy-modes`: per-category allow, approve or deny configuration, its simple setting and presets, and how it combines with the device allow-list.
- `owner-approval-mrtr`: MRTR-based owner approval for `approve` mode, including signed request state, expiry, binding to the exact action, and refusal when the client cannot elicit.

### Modified Capabilities

None. The Milestone B `controlled-mutation-policy` spec is not archived into `openspec/specs/` yet; this change supersedes its "refused by default" requirement once both are archived.

## Impact

- Code: `src\mutation-policy.ts`, `src\mutation-service.ts`, `src\http-server.ts` (tool registration and result handling), `src\service.ts` (config), a new approval module, and the tests beside them.
- Configuration: new `ACTION_POLICY` setting; documentation in `docs\cloud-deployment.md`.
- Dependency: `@modelcontextprotocol/sdk` 1.32.2 may not implement the 2026-07-28 MRTR result type. See the design for how this is handled.
- Risk: physical actions on shutters and heaters; every live test needs owner approval.
