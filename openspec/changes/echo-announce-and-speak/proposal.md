# Proposal

## Why

The agent can act on devices but cannot talk back into the house. The owner ranked "tell me on the Echo" as the most valuable next capability: it closes the loop for approvals, long jobs and reminders ("the boiler is on", "your approval is waiting"), and it is the return channel the planned "Alexa, ask Albert" skill needs. Nothing in the service can reach an Echo today; the adapter has no speech call.

## What Changes

- Add two MCP tools: `list_speakers` (read-only: which Echo devices exist, online or not, and what each can do) and `speak` (say a short text on one Echo, or announce it on several).
- Add an adapter call to the pinned `alexa-remote2` library's `sendSequenceCommand` for the `speak` and `announcement` commands.
- Add `SPEAK_POLICY` (`off` default, `approve`, `allow`) and `SPEAK_TARGETS` (names or serial numbers the agent may speak on; `*` for all) as settings. Echo devices are not in the device catalog, so targets are a separate allowlist.
- Every spoken text passes the same approval gate as device actions (approval prompt, or the chat-confirmation fallback), shows the exact text and target, and is journaled. Rate-limited.
- Not in scope: free-text commands to Alexa+ (`textCommand`), receiving what Alexa answers, routines, reminders, lists, SSML from the agent, and the Albert skill. These are separate roadmap entries.
- Distinguishes proposed from verified: the upstream notes say `speak` and `announcement` are built to documented shapes and not live-verified, so the live check is a task, not an assumption.

Requirement references: REQUIREMENTS.md §5 Speech/SSML family, SEC-04..07 (approval and privacy), REL-04..05 (outcomes), C3 `routines-and-speech` in the roadmap (speech part only).

## Capabilities

### New Capabilities
- `echo-speech`: listing speakers, speaking or announcing a short text on allowed Echo devices, gated by policy, approval, rate limits and the journal.

### Modified Capabilities

None. Existing specs are unchanged; speech is gated by its own setting and does not alter the device action categories.

## Impact

- `src\alexa-adapter.ts`, `src\ports.ts`: new `speak` port method and client method type.
- `src\http-server.ts`: the two tools; `src\service.ts`: settings and wiring; a new `src\speech-service.ts` for policy, target allowlist, rate limit, journal and approval.
- `src\approval-gate.ts`: reused unchanged (including the `approval.requested` doorbell).
- Docs: `docs\cloud-deployment.md` for the two settings and the privacy notes.
- Private data stays out of the repo: Echo names and serials live only in the site setting.
