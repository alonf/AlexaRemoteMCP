## Context

`SPEAK_TARGETS` is a single environment list. The private device catalog already stores per-device category and group and has an edit and approval flow.

## Decisions

- Reuse the catalog store and tools rather than a new store: one place to review devices. Speakers are `other` entries with a `speaker` flags object, edited on the owner-only admin page (not the agent-facing catalog tools, so an agent cannot widen its own speaker access).
- Flags default to off and are individually opt-in, so enabling announce never implies bypass or volume.
- Urgent flag off downgrades to approval rather than refusing, so a safety message is never silently lost. This differs from the urgent rate limit, which refuses by design.
- `features` is a reserved list. Camera, video and chat are not implemented here; Echo Show camera and Alexa calling access through the unofficial API are unverified.
- Migration: while no speaker has a catalog entry, `SPEAK_TARGETS` behaves as today.

## Open questions

- Does the Alexa device list expose a stable per-Echo identifier and capability list to seed flags from?
