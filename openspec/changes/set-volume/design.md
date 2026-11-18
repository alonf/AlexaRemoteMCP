## Context

`speak` already sends Alexa sequence commands to allowed Echos.

## Decisions

- Reuse `sendSequenceCommand(serial, 'volume', level)` through a new `setVolume` port method; the same write handling as `speak` applies.
- Implemented in `SpeechService` to share the allowlist, approval gate and rate limit.
- A ceiling rather than a refusal for high values, because the agent does not know the cap.
- Reading the current volume and restoring it are deferred until a live check shows upstream can read it. The `volume` command is unverified live; accepted never means changed.
