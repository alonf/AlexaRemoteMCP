# Proposal

## Why

Speaker permissions are one global list (`SPEAK_TARGETS`) and one global urgent bypass. The owner wants to decide per Echo what the agent may do (announce, bypass approval, change volume) and to manage Echo-specific features such as camera, from the same catalog page used for other devices. A global environment setting is too coarse and needs a redeploy to change.

## What Changes

- Echo speakers become catalog entries (category `other` plus a `speaker` flags object, keyed by the Echo serial), discovered from the live device list and edited on the owner-only admin catalog page.
- Per-speaker flags, all default off: `announce` (agent may speak on it), `urgent` (the urgent reason bypass applies; when off, urgent calls fall back to approval), `volume` (agent may set its volume, with a per-speaker ceiling), and `features` (future: camera snapshot, short video, two-way chat), each individually opt-in.
- `SPEAK_TARGETS` remains as a fallback only when no speaker catalog entry exists, then is deprecated.
- Catalog edits to speakers are journaled like other admin edits; no device names or serials in the journal.
- Not in scope: building camera, video or voice-chat features. This change only provides the flag surface. Each feature needs its own feasibility check and change.

## Capabilities

### New Capabilities
- `speaker-controls`: per-speaker permissions in the catalog.

### Modified Capabilities

None.

## Impact

- `src\catalog-service.ts`, `src\speech-service.ts`, `src\service.ts`, `src\http-server.ts`, `docs\cloud-deployment.md`. Unlisted speakers are refused identically to unknown ones.
