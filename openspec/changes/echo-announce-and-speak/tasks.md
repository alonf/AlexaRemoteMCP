## 1. Adapter and settings

- [x] 1.1 Add a `speak` method to `AlexaPort`/`AlexaAdapter` over `sendSequenceCommand` (speak and announcement), returning the shared write response; extend the client type and the fake used in tests
- [x] 1.2 Add `SPEAK_POLICY` and `SPEAK_TARGETS` to `loadConfig` (invalid value stops startup naming only the setting); document defaults

## 2. Speech service

- [x] 2.1 Add `src\speech-service.ts`: text validation (plain, 250 chars, control characters stripped, markup refused), target matching against `echoDevices()` with uniform refusals, offline refusal
- [x] 2.2 Gate through `gateApproval` (exact text and target in the summary, spoken-confirmation fallback), journal the attempt with hash, target count and outcome only
- [x] 2.3 In-memory rate limit of 5 per 10 minutes

## 3. Tools

- [x] 3.1 Add `list_speakers` (read scope; names, online, can speak; no serials)
- [x] 3.2 Add `speak` (mutate scope; `text`, `mode`, `device(s)`, approval fields); register only when speech is not off
- [x] 3.3 Wire the service and the `approval.requested` doorbell in `service.ts`

## 4. Verification

- [x] 4.1 Tests: refused targets look identical; markup and over-length refused; approval binding to text/mode/targets; replay refused; rate limit; journal and log hold no text or device name; upstream refusal reported as failure
- [x] 4.2 Lint, full tests and the secret scan
- [ ] 4.3 Owner-approved live check: one short phrase on one named Echo (speak, then announce); record the sanitized outcome
- [x] 4.4 Docs: `docs\cloud-deployment.md` (settings, privacy, limits) and the roadmap entry
