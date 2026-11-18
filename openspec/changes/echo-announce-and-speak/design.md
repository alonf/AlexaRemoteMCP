## Context

The service wraps `alexa-remote2` behind `AlexaPort`. Device actions are policy-checked, approved through `gateApproval` (MRTR prompt or chat-confirmation fallback), journaled, and reported with honest outcomes. The pinned library exposes `sendSequenceCommand(serialOrName, command, value, callback)`; its `speak` command builds an `Alexa.Speak` node (250 character limit, one device) and `announcement` builds an `AlexaAnnouncement` node (chime, any number of devices). Upstream notes mark both as not live-verified.

## Decisions

**D1: Separate setting, not a new action category.** Echo devices are not smart-home endpoints and are not in the device catalog. `SPEAK_POLICY` (`off` default, `approve`, `allow`) and `SPEAK_TARGETS` gate speech on their own, so the `ACTION_POLICY` categories and catalog schema stay untouched. Default off means a deploy changes nothing until the owner opts in.

**D2: Target allowlist by name or serial, private.** `SPEAK_TARGETS` is a site setting (`*` allows every Echo). Matching happens server-side against `echoDevices()`; the agent only ever sees display names from `list_speakers`. An unknown or disallowed target gets the same refusal, so existence is not revealed.

**D3: Reuse `gateApproval` unchanged.** The summary is `say "<text>" on <name>`, so the owner sees what will be spoken. Binding covers operation, text, mode and targets. The `approval.requested` doorbell fires for free.

**D4: Plain text only.** No SSML from the agent: SSML can inject sounds or long audio. Control characters are stripped, markup refused, 250 characters (the library's own limit) enforced up front so the error is ours.

**D5: One rate limit across all targets.** 5 per 10 minutes in process memory. A restart resets it, which is acceptable for an annoyance limit, not a security boundary (the approval is the boundary).

**D6: Records without content.** The journal already stores an arguments hash; the new operation records the hash, target count and outcome. The text and device names never reach the journal or logs.

**D7: Outcome honesty.** The library's callback only says the request was accepted. The reply uses `accepted`, never "heard". Announcements also depend on the Echo's own do-not-disturb and the library's fixed announcement locale (de-DE); the live check records how that behaves.

**D8: Live check is a task.** Because upstream did not verify the calls, the owner approves one short test phrase on one Echo, and the result is recorded before docs claim support.

## Risks / Trade-offs

- **Library shape drift**: the call may be refused live. Mitigation: unit tests with a fake, one owner-approved live check, an honest failure reply.
- **Approval fatigue**: every phrase asks. Mitigation: `SPEAK_POLICY=allow` exists and is documented with the risk (an agent could speak anything at any hour); rate limit still applies.
- **Spoken prompt injection**: a phrase read aloud can trigger other voice assistants. Mitigation: approval default and the owner sees the exact text.

## Open Questions

- Whether announcements should be offered at all in the first release, given the fixed locale. Default: offer both, live check decides.
