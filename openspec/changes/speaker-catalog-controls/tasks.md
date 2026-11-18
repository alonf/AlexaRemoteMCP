## 1. Catalog

- [x] 1.1 Add the `speaker` flags object (`announce`, `urgent`, `volume`, volume ceiling, `features`) to the catalog model with off defaults
- [x] 1.2 Discover Echo devices from the live device list into the catalog on the admin page, which lists Echos with their flags

## 2. Speech

- [x] 2.1 Make `SpeechService` read per-speaker flags, keeping `SPEAK_TARGETS` as a fallback when no speaker entry exists
- [x] 2.2 Downgrade urgent calls to approval when the `urgent` flag is off

## 3. Verification

- [x] 3.1 Tests: defaults, announce refusal parity, urgent downgrade, fallback, journal content
- [x] 3.2 Docs in `docs\cloud-deployment.md`
