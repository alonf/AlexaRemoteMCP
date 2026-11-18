# Proposal

## Why

The owner wants the agent to adjust an Echo's volume, for example before an important announcement.

## What Changes

- Add a `set_volume` tool (mutate scope) that sets one allowed Echo to 0-100, clamped to `SPEAK_VOLUME_MAX` (default 70).
- Uses the speaker allowlist and policy of `speak`: approval unless `SPEAK_POLICY=allow`; shared rate limit; offline and disallowed devices refused identically to unknown ones.
- Journaled as operation `volume` with target `speech:1`; no device names, serials or values beyond the parameters.
- Not in scope: reading the current volume, automatic restore, urgent-only volume on `speak` (later, after a live check).

## Capabilities

### New Capabilities
- `set-volume`: approved volume changes on allowed Echos.

### Modified Capabilities

None.

## Impact

- `src\speech-service.ts`, `src\alexa-adapter.ts`, `src\ports.ts`, `src\server.ts`, `src\http-server.ts`, `src\service.ts`, `docs\cloud-deployment.md`.
