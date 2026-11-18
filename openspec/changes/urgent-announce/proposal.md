# Proposal

## Why

`speak` (change `echo-announce-and-speak`) asks the owner to approve every text. That is right for ordinary messages but wrong when the agent has something urgent: an emergency, a family member waiting at a station, a payment due in minutes. Waiting for an approval that reaches the owner through the same agent defeats the purpose. The owner wants a short, owner-defined list of reasons for which the agent may announce without approval.

## What Changes

- Add an optional `reason` argument to `speak`. When it is one of the owner's configured urgent reasons, the approval step is skipped. Any other value, or no reason, follows the normal policy.
- Add `SPEAK_URGENT_REASONS`: a comma-separated allowlist. Empty by default, which keeps the bypass off. Suggested value: `emergency,security,safety,health,family,time_critical`.
- Add `SPEAK_URGENT_LIMIT`: urgent announcements allowed per 10 minutes, default 2, counted separately from the normal limit.
- An urgent announcement still obeys every other rule: allowed devices only (`SPEAK_TARGETS`), plain text of at most 250 characters, offline refusal, and `SPEAK_POLICY` not `off`.
- The journal records the reason, target count, digest and outcome; never the text or device names.
- Every urgent announcement rings the owner's doorbell as a new `speech.urgent` event carrying the reason and no text, so the owner always learns of it.
- Not in scope: verifying that the reason is true (the server cannot), per-reason device lists, escalation to phone calls or SMS.

## Capabilities

### New Capabilities
- `urgent-announce`: approval-free announcements for owner-listed reasons, with a separate tight limit and a mandatory notification.

### Modified Capabilities

None; `echo-speech` is not yet archived, so this change extends it from outside.

## Impact

- `src\speech-service.ts`: reason check, separate limit, journal reason, notification hook.
- `src\http-server.ts`: `reason` argument on `speak`. `src\service.ts`: two settings and doorbell wiring. `src\events\delivery.ts`: new event type `speech.urgent`.
- Docs: `docs\cloud-deployment.md`.

## Risk accepted

The reason is claimed by the agent and cannot be verified. A misled agent could claim one. The bounds are the allowlist of reasons, the allowed-device list, the 2-per-10-minutes limit, the 250-character plain-text cap and the always-on notification.
